import path from 'node:path';
import { parseArgs } from 'node:util';
import { Agent } from '@strands-agents/sdk';
import { loadDotEnv, PROJECT_ROOT, readAgentEnv } from '../config/env.js';
import { assertCredentials, createModel, providerHosts } from '../agent/model.js';
import { loadCases } from './case-schema.js';
import { installNetGuard } from './netguard.js';
import { writeReports, summarize } from './report.js';
import { runEvaluation } from './runner.js';

/**
 * Real-LLM agent evaluations (opt-in; not part of `npm test`).
 *
 *   npm run eval                          # all cases once
 *   npm run eval -- --case status-lookup  # one case (repeatable / comma-separated)
 *   npm run eval -- --repeat 5            # reliability across runs
 *   npm run eval -- --judge               # add optional rubric-based quality scores
 *   npm run eval -- --list                # list case ids
 *
 * Exit codes: 0 all required criteria met; 1 required criteria failed; 2 configuration error.
 */
const { values } = parseArgs({
  options: {
    case: { type: 'string', multiple: true },
    tag: { type: 'string', multiple: true },
    repeat: { type: 'string', default: '1' },
    judge: { type: 'boolean', default: false },
    out: { type: 'string' },
    list: { type: 'boolean', default: false },
    'min-pass-rate': { type: 'string', default: '1' },
    'cases-dir': { type: 'string', default: path.join(PROJECT_ROOT, 'evals', 'cases') },
  },
});

loadDotEnv();
const allCases = loadCases(values['cases-dir']!);

if (values.list) {
  for (const c of allCases) process.stdout.write(`${c.id.padEnd(34)} ${c.description}\n`);
  process.exit(0);
}

const wanted = (values.case ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
const unknown = wanted.filter((id) => !allCases.some((c) => c.id === id));
if (unknown.length) {
  process.stderr.write(`Unknown case id(s): ${unknown.join(', ')}. Use --list.\n`);
  process.exit(2);
}
const tags = values.tag ?? [];
const cases = allCases.filter((c) => (!wanted.length || wanted.includes(c.id)) && (!tags.length || c.tags.some((t) => tags.includes(t))));
const repeat = Math.max(1, Number(values.repeat));
const minPassRate = Number(values['min-pass-rate']);

let env;
try {
  env = readAgentEnv();
  assertCredentials(env);
} catch (err) {
  process.stderr.write(`Configuration error: ${(err as Error).message}\nSee .env.example. Real-LLM evaluations require provider credentials.\n`);
  process.exit(2);
}

const { model, info } = await createModel(env);
const guard = installNetGuard([...providerHosts(env), ...(process.env.EVAL_EXTRA_ALLOWED_HOSTS ?? '').split(',').filter(Boolean)]);

// Preflight: one tiny tool-less call so credential/model problems surface as a configuration
// error (exit 2) instead of being recorded as agent failures in every case.
if (process.env.EVAL_SKIP_PREFLIGHT !== '1') {
  try {
    await new Agent({ model, printer: false, systemPrompt: 'Reply with the single word OK.' }).invoke('ping');
  } catch (err) {
    process.stderr.write(
      `Configuration error: LLM provider preflight failed for ${info.provider}/${info.modelId}: ${(err as Error).message}\n` +
        'No evaluation was executed. Configure credentials (see .env.example) and retry.\n',
    );
    process.exit(2);
  }
}

const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const outDir = values.out ? path.resolve(values.out) : path.join(PROJECT_ROOT, 'reports', 'runs', runId);
const backend = {
  timeoutMs: Number(process.env.EVAL_BACKEND_TIMEOUT_MS ?? 1000),
  maxRetries: Number(process.env.EVAL_BACKEND_MAX_RETRIES ?? 2),
  retryBaseDelayMs: Number(process.env.EVAL_BACKEND_RETRY_BASE_DELAY_MS ?? 100),
};
const startedAt = new Date().toISOString();
process.stderr.write(`[eval] run ${runId}: ${cases.length} case(s) x ${repeat} with ${info.provider}/${info.modelId}\n`);

const results = await runEvaluation(cases, {
  runId,
  outDir,
  fixturesDir: path.join(PROJECT_ROOT, 'fixtures'),
  model,
  modelLabel: info,
  env,
  repeat,
  backend,
  judge: values.judge ? { model } : undefined,
  onCaseDone: (r) => {
    process.stderr.write(`[eval] ${r.passed ? 'PASS' : 'FAIL'} ${r.caseId} (run ${r.iteration}, ${r.trace.latencyMs} ms)\n`);
    for (const a of r.failedAssertions) process.stderr.write(`        - ${a.id}: ${a.message}\n`);
  },
});
guard.uninstall();

const files = writeReports(
  outDir,
  {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    model: info,
    repeat,
    judgeEnabled: values.judge ?? false,
    backend,
    networkGuard: { blockedOrigins: [...new Set(guard.blocked)] },
    cases: cases.map((c) => c.id),
  },
  results,
);

const { cases: perCase, totals } = summarize(results);
const failing = perCase.filter((c) => c.passRate < minPassRate);
process.stderr.write(`[eval] ${totals.passed}/${totals.caseRuns} case runs passed. Reports: ${files.md} , ${files.json}\n`);
if (failing.length) {
  process.stderr.write(`[eval] Required criteria failed (pass rate < ${minPassRate}) for: ${failing.map((c) => `${c.caseId} (${c.passes}/${c.runs})`).join(', ')}\n`);
  process.exit(1);
}
process.exit(0);
