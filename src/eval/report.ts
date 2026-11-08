import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { toolErrorCode, toolSucceeded } from './trace.js';
import type { CaseRunResult } from './runner.js';

export interface ReportMeta {
  runId: string;
  startedAt: string;
  finishedAt: string;
  model: { provider: string; modelId: string; scripted?: boolean };
  repeat: number;
  judgeEnabled: boolean;
  backend: { timeoutMs: number; maxRetries: number };
  networkGuard: { blockedOrigins: string[] };
  /** Case ids selected for this run. */
  cases: string[];
}

export interface CaseSummary {
  caseId: string;
  runs: number;
  passes: number;
  passRate: number;
  meanLatencyMs: number;
  meanQualityScore: number | null;
}

export function summarize(results: CaseRunResult[]): { cases: CaseSummary[]; totals: Record<string, unknown> } {
  const byCase = new Map<string, CaseRunResult[]>();
  for (const r of results) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
  const cases: CaseSummary[] = [...byCase.entries()].map(([caseId, rs]) => {
    const scores = rs.map((r) => ('score' in r.quality ? r.quality.score : null)).filter((s): s is number => s !== null);
    return {
      caseId,
      runs: rs.length,
      passes: rs.filter((r) => r.passed).length,
      passRate: rs.filter((r) => r.passed).length / rs.length,
      meanLatencyMs: Math.round(rs.reduce((a, r) => a + r.trace.latencyMs, 0) / rs.length),
      meanQualityScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null,
    };
  });
  const usages = results.map((r) => r.trace.usage).filter((u) => u !== null);
  const costs = results.map((r) => ('usd' in r.cost ? r.cost.usd : null));
  const totals = {
    caseRuns: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    passRate: results.length ? results.filter((r) => r.passed).length / results.length : 0,
    casesPassingAllRuns: cases.filter((c) => c.passes === c.runs).length,
    distinctCases: cases.length,
    tokens:
      usages.length === results.length && usages.length > 0
        ? {
            inputTokens: usages.reduce((a, u) => a + u.inputTokens, 0),
            outputTokens: usages.reduce((a, u) => a + u.outputTokens, 0),
            totalTokens: usages.reduce((a, u) => a + u.totalTokens, 0),
          }
        : { unavailable: usages.length ? 'token usage missing for some runs' : 'token usage not reported' },
    costUsd: costs.every((c) => c !== null) && costs.length
      ? Math.round(costs.reduce((a, c) => a! + c!, 0)! * 1e6) / 1e6
      : { unavailable: results[0] && 'unavailable' in results[0].cost ? results[0].cost.unavailable : 'cost unavailable' },
  };
  return { cases, totals };
}

export function writeReports(outDir: string, meta: ReportMeta, results: CaseRunResult[]): { json: string; md: string } {
  const summary = summarize(results);
  const jsonPath = path.join(outDir, 'report.json');
  const mdPath = path.join(outDir, 'report.md');
  writeFileSync(jsonPath, JSON.stringify({ meta, summary, results }, null, 2));
  writeFileSync(mdPath, renderMarkdown(meta, summary, results));
  return { json: jsonPath, md: mdPath };
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function renderMarkdown(meta: ReportMeta, summary: ReturnType<typeof summarize>, results: CaseRunResult[]): string {
  const t = summary.totals as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`# Shipment agent evaluation report`);
  lines.push('');
  lines.push(`- **Run ID:** \`${meta.runId}\``);
  lines.push(`- **Started / finished:** ${meta.startedAt} → ${meta.finishedAt}`);
  lines.push(`- **Model:** ${meta.model.provider} / \`${meta.model.modelId}\`${meta.model.scripted ? ' (**scripted model — deterministic test, not real LLM behaviour**)' : ''}`);
  lines.push(`- **Repeats per case:** ${meta.repeat}`);
  lines.push(`- **Backend (mock) settings:** timeout ${meta.backend.timeoutMs} ms, max retries ${meta.backend.maxRetries}`);
  lines.push(`- **LLM judge:** ${meta.judgeEnabled ? 'enabled (quality score only; never affects pass/fail)' : 'disabled — quality scores unavailable'}`);
  lines.push(`- **Network guard blocked:** ${meta.networkGuard.blockedOrigins.length ? meta.networkGuard.blockedOrigins.join(', ') : 'none'}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Case runs | ${t.caseRuns} |`);
  lines.push(`| Passed / failed | ${t.passed} / ${t.failed} |`);
  lines.push(`| Pass rate | ${((t.passRate as number) * 100).toFixed(1)}% |`);
  lines.push(`| Cases passing all repeats | ${t.casesPassingAllRuns} / ${t.distinctCases} |`);
  lines.push(`| Tokens | ${fmtMaybe(t.tokens)} |`);
  lines.push(`| Estimated cost (USD) | ${fmtMaybe(t.costUsd)} |`);
  lines.push('');
  lines.push(`| Case | Runs | Passes | Pass rate | Mean latency (ms) | Mean quality (1-5) |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const c of summary.cases) {
    lines.push(`| \`${c.caseId}\` | ${c.runs} | ${c.passes} | ${(c.passRate * 100).toFixed(0)}% | ${c.meanLatencyMs} | ${c.meanQualityScore ?? 'unavailable'} |`);
  }
  lines.push('');
  lines.push(`## Case details`);
  for (const r of results) {
    lines.push('');
    lines.push(`### ${r.passed ? '✅' : '❌'} \`${r.caseId}\` (run ${r.iteration})`);
    lines.push('');
    lines.push(`${r.description}`);
    lines.push('');
    lines.push(`- Latency: ${r.trace.latencyMs} ms · Tokens: ${r.trace.usage ? `${r.trace.usage.inputTokens} in / ${r.trace.usage.outputTokens} out` : 'unavailable'} · Cost: ${'usd' in r.cost ? `$${r.cost.usd}` : `unavailable (${r.cost.unavailable})`}`);
    lines.push(`- Quality: ${'score' in r.quality ? `${r.quality.score}/5 — ${r.quality.rationale}` : `unavailable (${r.quality.unavailable})`}`);
    lines.push(`- Backend requests: ${r.trace.backendRequests.length} · Tickets created: ${r.trace.tickets.length}${r.trace.tickets.length ? ` (${r.trace.tickets.map((x) => x.ticketId).join(', ')})` : ''}`);
    if (r.trace.error) lines.push(`- **Error:** ${r.trace.error}`);
    if (r.failedAssertions.length) {
      lines.push('');
      lines.push(`**Failed assertions**`);
      lines.push('');
      for (const a of r.failedAssertions) lines.push(`- [${a.category}] \`${a.id}\`: ${esc(a.message)}`);
    }
    lines.push('');
    lines.push(`| Turn | Tool (MCP wire) | Arguments | Result | ms |`);
    lines.push(`|---|---|---|---|---|`);
    for (const turn of r.trace.turns) {
      if (!turn.mcpCalls.length) lines.push(`| ${turn.index} | _(no tool calls)_ | | | |`);
      for (const call of turn.mcpCalls) {
        const res = toolSucceeded(call) ? 'ok' : `error: ${toolErrorCode(call)}`;
        lines.push(`| ${turn.index} | \`${call.tool}\` | \`${esc(trunc(JSON.stringify(call.arguments), 120))}\` | ${res} | ${call.durationMs ?? '-'} |`);
      }
    }
    for (const turn of r.trace.turns) {
      lines.push('');
      lines.push(`> **User (turn ${turn.index}):** ${esc(turn.user)}`);
      lines.push(`>`);
      lines.push(`> **Agent:** ${esc(trunc(turn.response, 1200))}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function fmtMaybe(v: unknown): string {
  if (v && typeof v === 'object' && 'unavailable' in v) return `unavailable (${(v as { unavailable: string }).unavailable})`;
  if (v && typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${x}`).join(', ');
  return String(v);
}
