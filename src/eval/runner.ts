import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import type { Model } from '@strands-agents/sdk';
import { createShipmentAgent, finalText } from '../agent/agent.js';
import { McpTraceRecorder } from '../agent/recording-transport.js';
import type { AgentEnv } from '../config/env.js';
import { loadFixtureFile, mergeFixtures, resolveFixturePath } from '../mock/fixtures.js';
import { MockBackend } from '../mock/server.js';
import { evaluateCase, type AssertionResult } from './assertions.js';
import type { EvalCase } from './case-schema.js';
import { judgeCase, type JudgeResult } from './judge.js';
import { assertLoopback } from './netguard.js';
import type { CaseTrace, TokenUsage, TurnTrace } from './trace.js';

export interface EvalRunOptions {
  runId: string;
  outDir: string;
  fixturesDir: string;
  model: Model;
  modelLabel: { provider: string; modelId: string; scripted?: boolean };
  env: AgentEnv;
  repeat: number;
  /** Backend behaviour for the MCP servers during evals (short timeouts keep fault cases fast). */
  backend: { timeoutMs: number; maxRetries: number; retryBaseDelayMs: number };
  judge?: { model: Model } | undefined;
  /** Optional per-case model factory (used by deterministic tests with scripted models). */
  modelForCase?: (c: EvalCase) => Model;
  onCaseDone?: (r: CaseRunResult) => void;
}

export interface CaseRunResult {
  caseId: string;
  description: string;
  iteration: number;
  passed: boolean;
  assertions: AssertionResult[];
  failedAssertions: AssertionResult[];
  trace: CaseTrace;
  quality: JudgeResult | { unavailable: string };
  cost: { usd: number } | { unavailable: string };
}

export function computeCost(usage: TokenUsage | null, env: AgentEnv): CaseRunResult['cost'] {
  if (!usage) return { unavailable: 'token usage not reported by provider' };
  if (env.MODEL_INPUT_COST_PER_MTOK === undefined || env.MODEL_OUTPUT_COST_PER_MTOK === undefined) {
    return { unavailable: 'set MODEL_INPUT_COST_PER_MTOK and MODEL_OUTPUT_COST_PER_MTOK to estimate cost' };
  }
  const usd = (usage.inputTokens * env.MODEL_INPUT_COST_PER_MTOK + usage.outputTokens * env.MODEL_OUTPUT_COST_PER_MTOK) / 1e6;
  return { usd: Math.round(usd * 1e6) / 1e6 };
}

function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a) return b;
  if (!b) return a;
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, totalTokens: a.totalTokens + b.totalTokens };
}

function usageOf(result: { metrics?: { agentInvocations?: Array<{ usage?: Partial<TokenUsage> }> } | undefined }): TokenUsage | null {
  const inv = result.metrics?.agentInvocations?.at(-1);
  const u = inv?.usage;
  if (!u || (u.inputTokens === undefined && u.outputTokens === undefined)) return null;
  const input = u.inputTokens ?? 0;
  const output = u.outputTokens ?? 0;
  if (input === 0 && output === 0) return null;
  return { inputTokens: input, outputTokens: output, totalTokens: u.totalTokens ?? input + output };
}

/**
 * Runs the selected cases against: real model → Strands agent → MCP stdio servers (child
 * processes) → backend adapters → in-process mock HTTP backend. Only the backend is mocked.
 */
export async function runEvaluation(cases: EvalCase[], opts: EvalRunOptions): Promise<CaseRunResult[]> {
  mkdirSync(path.join(opts.outDir, 'logs'), { recursive: true });
  const mock = new MockBackend();
  const mockUrl = await mock.start(0);
  const serverEnv = {
    SHIPMENT_API_BASE_URL: `${mockUrl}/shipment-api`,
    SUPPORT_API_BASE_URL: `${mockUrl}/support-api`,
    BACKEND_ALLOWED_ORIGINS: new URL(mockUrl).origin,
    BACKEND_TIMEOUT_MS: String(opts.backend.timeoutMs),
    BACKEND_MAX_RETRIES: String(opts.backend.maxRetries),
    BACKEND_RETRY_BASE_DELAY_MS: String(opts.backend.retryBaseDelayMs),
    BACKEND_RETRY_MAX_DELAY_MS: '1000',
  };
  assertLoopback({ SHIPMENT_API_BASE_URL: serverEnv.SHIPMENT_API_BASE_URL, SUPPORT_API_BASE_URL: serverEnv.SUPPORT_API_BASE_URL });

  const results: CaseRunResult[] = [];
  try {
    for (let iteration = 1; iteration <= opts.repeat; iteration++) {
      for (const c of cases) {
        const r = await runOneCase(c, iteration, opts, mock, serverEnv);
        results.push(r);
        opts.onCaseDone?.(r);
      }
    }
  } finally {
    await mock.stop();
  }
  return results;
}

async function runOneCase(
  c: EvalCase,
  iteration: number,
  opts: EvalRunOptions,
  mock: MockBackend,
  serverEnv: Record<string, string>,
): Promise<CaseRunResult> {
  // 1. Reset backend state and load this case's fixtures, tagged for correlation.
  const fixtures = mergeFixtures(
    ...c.fixtures.map((f) => loadFixtureFile(resolveFixturePath(opts.fixturesDir, f))),
    ...(c.fixtureOverrides ? [c.fixtureOverrides] : []),
  );
  mock.loadFixtures(fixtures, { runId: opts.runId, caseId: c.id });

  // 2. Fresh agent (fresh conversation) and fresh MCP server processes for every case.
  const recorder = new McpTraceRecorder();
  recorder.tags = { runId: opts.runId, caseId: c.id, iteration: String(iteration) };
  const logStream: WriteStream = createWriteStream(path.join(opts.outDir, 'logs', `${c.id}.${iteration}.mcp-stderr.log`));
  const model = opts.modelForCase?.(c) ?? opts.model;
  const handle = createShipmentAgent({ model, env: opts.env, serverEnv, stderr: logStream, recorder });

  const trace: CaseTrace = {
    runId: opts.runId,
    caseId: c.id,
    iteration,
    turns: [],
    mcpCalls: recorder.calls,
    agentToolEvents: handle.toolEvents,
    backendRequests: [],
    tickets: [],
    error: null,
    timedOut: false,
    latencyMs: 0,
    usage: null,
  };

  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), c.timeoutMs);
  });

  const conversation = (async () => {
    for (const [i, turn] of c.turns.entries()) {
      recorder.tags.turn = String(i + 1);
      const callsBefore = recorder.calls.length;
      const eventsBefore = handle.toolEvents.length;
      const t0 = performance.now();
      const result = await handle.agent.invoke(turn.user);
      const tt: TurnTrace = {
        index: i + 1,
        user: turn.user,
        response: finalText(result),
        latencyMs: Math.round(performance.now() - t0),
        mcpCalls: recorder.calls.slice(callsBefore),
        agentToolEvents: handle.toolEvents.slice(eventsBefore),
        usage: usageOf(result as never),
      };
      trace.turns.push(tt);
      trace.usage = addUsage(trace.usage, tt.usage);
    }
  })();

  try {
    const outcome = await Promise.race([conversation.then(() => 'done' as const), timeout]);
    if (outcome === 'timeout') {
      trace.timedOut = true;
      handle.agent.cancel();
      await Promise.race([conversation.catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
    }
  } catch (err) {
    trace.error = (err as Error).message ?? String(err);
  } finally {
    clearTimeout(timer);
    trace.latencyMs = Math.round(performance.now() - started);
    // 3. Tear down MCP processes before reading backend state so no request is still in flight.
    await handle.close();
    await new Promise<void>((r) => logStream.end(() => r()));
  }

  trace.backendRequests = mock.getRequests();
  trace.tickets = mock.getTickets();

  const assertions = evaluateCase(c, trace);
  const failedAssertions = assertions.filter((a) => !a.passed);

  let quality: CaseRunResult['quality'] = { unavailable: 'LLM judge not enabled (use --judge)' };
  if (opts.judge && trace.turns.length > 0) {
    try {
      quality = await judgeCase(opts.judge.model, trace, c.qualityRubric);
    } catch (err) {
      quality = { unavailable: `judge failed: ${(err as Error).message}` };
    }
  }

  return {
    caseId: c.id,
    description: c.description,
    iteration,
    passed: failedAssertions.length === 0,
    assertions,
    failedAssertions,
    trace,
    quality,
    cost: opts.modelLabel.scripted ? { unavailable: 'scripted model (no LLM)' } : computeCost(trace.usage, opts.env),
  };
}
