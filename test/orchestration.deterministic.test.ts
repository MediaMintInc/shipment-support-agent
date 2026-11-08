import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAgentEnv } from '../src/config/env.js';
import { loadCases, type EvalCase } from '../src/eval/case-schema.js';
import { writeReports } from '../src/eval/report.js';
import { runEvaluation, type CaseRunResult } from '../src/eval/runner.js';
import { ScriptedModel, sequence, type Script } from './helpers/scripted-model.js';

/**
 * DETERMINISTIC ORCHESTRATION TESTS (scripted model, no LLM).
 *
 * These drive the real Strands Agent → McpClient → stdio MCP server processes → backend adapters
 * → mock HTTP backend, and the real evaluation harness, using a scripted model. They prove the
 * plumbing, trace capture and assertions work. They are NOT evidence of real LLM behaviour —
 * that is what `npm run eval` measures.
 */

const all = loadCases(path.resolve('evals/cases'));
const byId = (id: string): EvalCase => {
  const c = all.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};

const scripts: Record<string, Script> = {
  'status-lookup': sequence([{ tool: 'get_shipment_status', input: { shipment_id: 'SHP-100001' } }], (v) => {
    const r = v.lastToolResults[0] as Record<string, string>;
    return `Shipment ${r.shipment_id} is ${r.status} from ${r.origin} to ${r.destination}, estimated delivery ${r.estimated_delivery}.`;
  }),
  'missing-shipment-id': sequence([], () => 'Could you share your shipment ID? It starts with SHP- followed by digits.'),
  'temporary-backend-failure': sequence([{ tool: 'get_shipment_status', input: { shipment_id: 'SHP-100001' } }], (v) => {
    const r = v.lastToolResults[0] as Record<string, string>;
    return `Shipment ${r.shipment_id} is ${r.status}.`;
  }),
  'persistent-timeout': sequence([{ tool: 'get_shipment_status', input: { shipment_id: 'SHP-100001' } }], (v) => {
    const r = v.lastToolResults[0] as { ok: boolean; error?: { code: string } };
    return r.ok ? 'unexpected' : `Sorry, the shipment system timed out (${r.error?.code}). Please try again later.`;
  }),
  'ticket-retry-idempotent': sequence(
    [
      {
        tool: 'create_support_ticket',
        input: {
          shipment_id: 'SHP-100002',
          category: 'LOST',
          description: 'Marked delivered but customer never received the package',
          user_explicitly_requested: true,
          user_request_quote: 'Please create a support ticket for SHP-100002',
          idempotency_key: 'SHP-100002-LOST-1',
        },
      },
    ],
    (v) => `I created support ticket ${String((v.lastToolResults[0] as Record<string, unknown>).ticket_id)} for SHP-100002.`,
  ),
  'multi-turn-context': (() => {
    // Turn-aware script: respond based on the latest user message and last tool results.
    return (v) => {
      const last = v.userMessages.at(-1) ?? '';
      const tr = v.lastToolResults[0];
      if (tr) {
        if ('ticket_id' in tr) return { text: `Ticket ${String(tr.ticket_id)} has been created for SHP-100003.` };
        if ('exceptions' in tr) return { text: `There is an open address issue: ${String((tr.exceptions as Array<{ description: string }>)[0]?.description)}.` };
        return { text: `SHP-100003 has status ${String(tr.status)}.` };
      }
      if (/ticket/i.test(last)) {
        return {
          tool: 'create_support_ticket',
          input: {
            shipment_id: 'SHP-100003',
            category: 'DELIVERY_EXCEPTION',
            description: 'Address could not be located: apartment number missing',
            user_explicitly_requested: true,
            user_request_quote: last,
            idempotency_key: 'SHP-100003-DELIVERY_EXCEPTION-1',
          },
        };
      }
      if (/exception/i.test(last)) return { tool: 'get_delivery_exceptions', input: { shipment_id: 'SHP-100003' } };
      return { tool: 'get_shipment_status', input: { shipment_id: 'SHP-100003' } };
    };
  })(),
};

/** Deliberately misbehaving scripts: the harness must FAIL these. */
const badScripts: Record<string, Script> = {
  // Creates a ticket on a status-only question.
  'status-only-no-ticket': sequence(
    [
      { tool: 'get_shipment_status', input: { shipment_id: 'SHP-100003' } },
      {
        tool: 'create_support_ticket',
        input: {
          shipment_id: 'SHP-100003',
          category: 'DELIVERY_EXCEPTION',
          description: 'Proactive ticket for address exception',
          user_explicitly_requested: true,
          user_request_quote: 'status',
        },
      },
    ],
    () => 'There is an exception on SHP-100003, and I opened a ticket for it.',
  ),
  // Fabricates facts for an unknown shipment.
  'unknown-shipment': sequence(
    [{ tool: 'get_shipment_status', input: { shipment_id: 'SHP-999999' } }],
    () => 'SHP-999999 was delivered in Boston, MA on November 2.',
  ),
  // Claims a ticket despite the backend failing.
  'ticket-failure-no-false-claim': sequence(
    [
      {
        tool: 'create_support_ticket',
        input: {
          shipment_id: 'SHP-100003',
          category: 'DELIVERY_EXCEPTION',
          description: 'Address problem reported by customer',
          user_explicitly_requested: true,
          user_request_quote: 'Please open a support ticket',
        },
      },
    ],
    () => 'Your support ticket has been created successfully.',
  ),
};

async function run(ids: string[], scriptTable: Record<string, Script>): Promise<{ results: CaseRunResult[]; outDir: string }> {
  const outDir = mkdtempSync(path.join(tmpdir(), 'eval-det-'));
  const cases = ids.map(byId);
  const env = readAgentEnv({});
  const results = await runEvaluation(cases, {
    runId: 'deterministic-test',
    outDir,
    fixturesDir: path.resolve('fixtures'),
    model: new ScriptedModel(() => ({ text: 'unused' })),
    modelForCase: (c) => new ScriptedModel(scriptTable[c.id]!),
    modelLabel: { provider: 'scripted', modelId: 'scripted-model', scripted: true },
    env,
    repeat: 1,
    backend: { timeoutMs: 300, maxRetries: 2, retryBaseDelayMs: 1 },
  });
  return { results, outDir };
}

describe('deterministic orchestration (scripted model — not LLM evidence)', () => {
  it('well-behaved scripts pass every hard assertion through the real MCP stack', async () => {
    const ids = Object.keys(scripts);
    const startedAt = new Date().toISOString();
    const { results, outDir } = await run(ids, scripts);
    for (const r of results) {
      expect(r.failedAssertions, `${r.caseId}: ${JSON.stringify(r.failedAssertions, null, 2)}`).toEqual([]);
      expect(r.trace.mcpCalls.every((c) => c.tags.caseId === r.caseId && c.tags.runId === 'deterministic-test')).toBe(true);
    }

    const retry = results.find((r) => r.caseId === 'ticket-retry-idempotent')!;
    expect(retry.trace.tickets).toHaveLength(1);
    expect(retry.trace.backendRequests.filter((b) => b.method === 'POST')).toHaveLength(2);

    const mt = results.find((r) => r.caseId === 'multi-turn-context')!;
    expect(mt.trace.turns.map((t) => t.mcpCalls.map((c) => c.tool))).toEqual([
      ['get_shipment_status'],
      ['get_delivery_exceptions'],
      ['create_support_ticket'],
    ]);

    // `npm run report:sample` sets SAMPLE_REPORT_DIR to keep this report as a committed sample.
    const reportDir = process.env.SAMPLE_REPORT_DIR ? path.resolve(process.env.SAMPLE_REPORT_DIR) : outDir;
    mkdirSync(reportDir, { recursive: true });
    const files = writeReports(
      reportDir,
      {
        runId: 'deterministic-test',
        startedAt,
        finishedAt: new Date().toISOString(),
        model: { provider: 'scripted', modelId: 'scripted-model', scripted: true },
        repeat: 1,
        judgeEnabled: false,
        backend: { timeoutMs: 300, maxRetries: 2 },
        networkGuard: { blockedOrigins: [] },
        cases: ids,
      },
      results,
    );
    const md = readFileSync(files.md, 'utf8');
    expect(md).toMatch(/scripted model — deterministic test, not real LLM behaviour/);
    expect(md).toMatch(/Tokens \| unavailable/);
    const json = JSON.parse(readFileSync(files.json, 'utf8')) as { summary: { totals: { failed: number } } };
    expect(json.summary.totals.failed).toBe(0);
  }, 90_000);

  it('misbehaving scripts are caught by hard assertions', async () => {
    const { results } = await run(Object.keys(badScripts), badScripts);
    const failedIds = (id: string) => results.find((r) => r.caseId === id)!.failedAssertions.map((a) => a.id);

    expect(results.every((r) => !r.passed)).toBe(true);
    expect(failedIds('status-only-no-ticket')).toEqual(expect.arrayContaining(['case:forbidden:create_support_ticket', 'case:ticketsCreated']));
    expect(failedIds('unknown-shipment')).toEqual(expect.arrayContaining(['turn1:grounded']));
    expect(failedIds('ticket-failure-no-false-claim')).toEqual(expect.arrayContaining(['turn1:noFalseTicketClaim']));
  }, 90_000);
});
