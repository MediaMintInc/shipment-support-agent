import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpCallRecord } from '../src/agent/recording-transport.js';
import { checkGrounding, checkTicketClaims, checkToolExpect, extractDates, type GroundingContext } from '../src/eval/assertions.js';
import { loadCases, ToolExpectSchema } from '../src/eval/case-schema.js';
import { existsSync } from 'node:fs';

const ctx = (toolTexts: string[], user: string[] = [], tickets: string[] = []): GroundingContext => ({
  userMessages: user,
  toolTexts,
  confirmedTicketIds: tickets,
});

const statusResult = JSON.stringify({ ok: true, shipment_id: 'SHP-100001', status: 'IN_TRANSIT', destination: 'Denver, CO', estimated_delivery: '2026-11-10' });

describe('grounding check (fabrication detection)', () => {
  it('passes when every fact comes from tool data', () => {
    const [r] = checkGrounding('t', 'SHP-100001 is in transit to Denver, CO, arriving November 10.', ctx([statusResult]));
    expect(r!.passed).toBe(true);
  });

  it('flags invented dates, places and statuses', () => {
    const [r] = checkGrounding('t', 'SHP-100001 was delivered in Boston, MA on November 2.', ctx([statusResult]));
    expect(r!.passed).toBe(false);
    expect(r!.message).toMatch(/Boston, MA/);
    expect(r!.message).toMatch(/November 2/);
    expect(r!.message).toMatch(/status claim/);
  });

  it('flags invented shipment ids and amounts', () => {
    const [r] = checkGrounding('t', 'I found SHP-123456 and issued a $50 credit.', ctx([statusResult]));
    expect(r!.passed).toBe(false);
  });

  it('does not flag negated or questioned statuses', () => {
    const [r] = checkGrounding('t', "I couldn't confirm whether it was delivered. Do you know if it was delivered?", ctx(['{"ok":false}']));
    expect(r!.passed).toBe(true);
  });

  it('parses common date formats', () => {
    expect(extractDates('Nov 10, 2026-11-04, 5th November, 11/06').map((d) => `${d.m}-${d.d}`)).toEqual(['11-4', '11-10', '11-5', '11-6']);
  });
});

describe('ticket claim check', () => {
  it('fails a success claim when no ticket was confirmed', () => {
    const [r] = checkTicketClaims('t', 'Your support ticket has been created and our team will contact you.', ctx([]));
    expect(r!.passed).toBe(false);
  });
  it('fails an invented ticket id', () => {
    const [r] = checkTicketClaims('t', 'Ticket TCK-9999 is open.', ctx([], [], ['TCK-5001']));
    expect(r!.passed).toBe(false);
  });
  it('allows honest failure statements', () => {
    const [r] = checkTicketClaims('t', 'The ticket could not be created because the support system returned an error. No ticket was created.', ctx([]));
    expect(r!.passed).toBe(true);
  });
  it('allows confirmed tickets', () => {
    const [r] = checkTicketClaims('t', 'I have created ticket TCK-5001 for you.', ctx([], [], ['TCK-5001']));
    expect(r!.passed).toBe(true);
  });
});

describe('tool expectations', () => {
  const rec = (tool: string, args: Record<string, unknown>, ok = true): McpCallRecord => ({
    server: 's',
    requestId: 1,
    tool,
    arguments: args,
    startedAt: '',
    durationMs: 1,
    result: { content: [{ type: 'text', text: '{}' }], isError: !ok },
    isError: !ok,
    rpcError: null,
    tags: {},
  });

  it('checks required args, forbidden tools, ordering and max calls', () => {
    const exp = ToolExpectSchema.parse({
      required: [{ tool: 'create_support_ticket', args: { shipment_id: { equals: 'SHP-100003' } }, maxCount: 1 }],
      forbidden: ['get_tracking_history'],
      ordering: [['get_delivery_exceptions', 'create_support_ticket']],
      maxToolCalls: 2,
    });
    const good = [rec('get_delivery_exceptions', { shipment_id: 'SHP-100003' }), rec('create_support_ticket', { shipment_id: 'shp-100003' })];
    expect(checkToolExpect('c', exp, good, []).every((a) => a.passed)).toBe(true);

    const bad = [rec('create_support_ticket', { shipment_id: 'SHP-100001' }), rec('get_delivery_exceptions', {}), rec('get_tracking_history', {})];
    const failed = checkToolExpect('c', exp, bad, []).filter((a) => !a.passed).map((a) => a.id);
    expect(failed).toEqual(
      expect.arrayContaining(['c:required:create_support_ticket', 'c:forbidden:get_tracking_history', 'c:ordering:get_delivery_exceptions<create_support_ticket', 'c:maxToolCalls']),
    );
  });
});

describe('evaluation case files', () => {
  const cases = loadCases(path.resolve('evals/cases'));
  it('defines all required scenarios', () => {
    expect(cases.length).toBeGreaterThanOrEqual(13);
    expect(cases.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'status-lookup',
        'tracking-history',
        'missing-shipment-id',
        'unknown-shipment',
        'delivery-exception',
        'explicit-ticket-request',
        'status-only-no-ticket',
        'temporary-backend-failure',
        'persistent-timeout',
        'malformed-backend-response',
        'prompt-injection-in-tool-data',
        'multi-turn-context',
        'ticket-retry-idempotent',
      ]),
    );
  });
  it('reference existing fixture files and have valid regexes', () => {
    for (const c of cases) {
      for (const f of c.fixtures) expect(existsSync(path.resolve('fixtures', f)), `${c.id}: ${f}`).toBe(true);
      const patterns = [
        ...c.expect.response.mustMentionAll,
        ...c.expect.response.mustMentionAny,
        ...c.expect.response.mustNotMention,
        ...c.turns.flatMap((t) => [...(t.expect?.response?.mustMentionAll ?? []), ...(t.expect?.response?.mustNotMention ?? [])]),
      ];
      for (const p of patterns) expect(() => new RegExp(p, 'i'), `${c.id}: ${p}`).not.toThrow();
    }
  });
});
