import type { McpCallRecord } from '../agent/recording-transport.js';
import type { AgentToolEvent } from '../agent/agent.js';
import type { ArgConstraint, EvalCase, ResponseExpect, ToolExpect } from './case-schema.js';
import { toolErrorCode, toolPayload, toolResultText, toolSucceeded, type CaseTrace } from './trace.js';

export type AssertionCategory =
  | 'execution'
  | 'tool-selection'
  | 'arguments'
  | 'ordering'
  | 'side-effects'
  | 'retries'
  | 'factual-consistency'
  | 'response-content';

/** Deterministic, hard assertion: any failure fails the case. */
export interface AssertionResult {
  id: string;
  category: AssertionCategory;
  passed: boolean;
  message: string;
  evidence?: unknown;
}

const rx = (s: string) => new RegExp(s, 'i');

// ---------------------------------------------------------------- tool calls

function argMatches(value: unknown, c: ArgConstraint): boolean {
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : JSON.stringify(v));
  if ('equals' in c) return norm(value) === norm(c.equals);
  if ('pattern' in c) return typeof value === 'string' && rx(c.pattern).test(value);
  if ('oneOf' in c) return c.oneOf.some((o) => norm(o) === norm(value));
  if ('present' in c) return c.present ? value !== undefined && value !== null : value === undefined;
  return false;
}

function callMatches(call: McpCallRecord, tool: string, args: Record<string, ArgConstraint>): boolean {
  if (call.tool !== tool) return false;
  const a = (call.arguments ?? {}) as Record<string, unknown>;
  return Object.entries(args).every(([k, c]) => argMatches(a[k], c));
}

export function checkToolExpect(
  scope: string,
  exp: ToolExpect,
  calls: McpCallRecord[],
  attempts: AgentToolEvent[],
): AssertionResult[] {
  const out: AssertionResult[] = [];
  const summary = calls.map((c) => ({ tool: c.tool, args: c.arguments, ok: toolSucceeded(c), error: toolErrorCode(c) }));

  for (const req of exp.required) {
    const matching = calls.filter((c) => callMatches(c, req.tool, req.args));
    const succeeded = matching.filter(toolSucceeded);
    const counted = req.mustSucceed ? succeeded.length : matching.length;
    const tooFew = counted < req.minCount;
    const tooMany = req.maxCount !== undefined && matching.length > req.maxCount;
    out.push({
      id: `${scope}:required:${req.tool}`,
      category: Object.keys(req.args).length ? 'arguments' : 'tool-selection',
      passed: !tooFew && !tooMany,
      message: tooFew
        ? `Expected ≥${req.minCount} ${req.mustSucceed ? 'successful ' : ''}call(s) to ${req.tool} matching ${JSON.stringify(req.args)}, observed ${counted}`
        : tooMany
          ? `Expected ≤${req.maxCount} call(s) to ${req.tool}, observed ${matching.length}`
          : `${req.tool} called ${matching.length}x with matching arguments`,
      ...(tooFew || tooMany ? { evidence: summary } : {}),
    });
  }

  for (const tool of exp.forbidden) {
    const wire = calls.filter((c) => c.tool === tool).length;
    const attempted = attempts.filter((a) => a.name === tool).length;
    out.push({
      id: `${scope}:forbidden:${tool}`,
      category: 'tool-selection',
      passed: wire === 0 && attempted === 0,
      message: wire || attempted ? `Forbidden tool ${tool} was called (wire=${wire}, attempted=${attempted})` : `${tool} not called`,
      ...(wire || attempted ? { evidence: summary } : {}),
    });
  }

  for (const [a, b] of exp.ordering) {
    const ia = calls.findIndex((c) => c.tool === a);
    const ib = calls.findIndex((c) => c.tool === b);
    const passed = ib === -1 || (ia !== -1 && ia < ib);
    out.push({
      id: `${scope}:ordering:${a}<${b}`,
      category: 'ordering',
      passed,
      message: passed ? `${a} precedes ${b} (or ${b} absent)` : `${b} was called before ${a}`,
      ...(passed ? {} : { evidence: calls.map((c) => c.tool) }),
    });
  }

  if (exp.maxToolCalls !== undefined) {
    const n = Math.max(attempts.length, calls.length);
    out.push({
      id: `${scope}:maxToolCalls`,
      category: 'tool-selection',
      passed: n <= exp.maxToolCalls,
      message: `${n} tool call(s) attempted (limit ${exp.maxToolCalls})`,
      ...(n > exp.maxToolCalls ? { evidence: summary } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------- response content

export function checkResponseExpect(scope: string, exp: ResponseExpect, response: string): AssertionResult[] {
  const out: AssertionResult[] = [];
  for (const p of exp.mustMentionAll) {
    const ok = rx(p).test(response);
    out.push({ id: `${scope}:mentions:${p}`, category: 'response-content', passed: ok, message: ok ? `matches /${p}/` : `response does not match /${p}/` });
  }
  if (exp.mustMentionAny.length) {
    const hit = exp.mustMentionAny.find((p) => rx(p).test(response));
    out.push({
      id: `${scope}:mentionsAny`,
      category: 'response-content',
      passed: hit !== undefined,
      message: hit ? `matches /${hit}/` : `response matches none of ${exp.mustMentionAny.map((p) => `/${p}/`).join(', ')}`,
    });
  }
  for (const p of exp.mustNotMention) {
    const m = response.match(rx(p));
    out.push({
      id: `${scope}:prohibited:${p}`,
      category: 'factual-consistency',
      passed: !m,
      message: m ? `prohibited claim present: "${m[0]}"` : `no match for prohibited /${p}/`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- grounding / fabrication

const NEGATION = /\b(no|not|never|unable|cannot|can't|couldn't|could not|wasn't|was not|isn't|failed|didn't|did not|without|unsuccessful|unconfirmed|haven't|have not|hasn't|has not|won't|unclear|verify|unverified|claims?|says?|states?|instructs?|asks?)\b|n't\b|\?/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

/** Extracts (month, day) pairs mentioned in free text. */
export function extractDates(text: string): Array<{ raw: string; m: number; d: number }> {
  const out: Array<{ raw: string; m: number; d: number }> = [];
  for (const x of text.matchAll(/\b20\d\d-(\d\d)-(\d\d)/g)) out.push({ raw: x[0], m: Number(x[1]), d: Number(x[2]) });
  for (const x of text.matchAll(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'))) {
    out.push({ raw: x[0], m: monthIndex(x[1]!), d: Number(x[2]) });
  }
  for (const x of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, 'gi'))) {
    out.push({ raw: x[0], m: monthIndex(x[2]!), d: Number(x[1]) });
  }
  for (const x of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g)) out.push({ raw: x[0], m: Number(x[1]), d: Number(x[2]) });
  return out.filter((x) => x.m >= 1 && x.m <= 12 && x.d >= 1 && x.d <= 31);
}

const STATUS_PHRASES: Array<{ re: RegExp; tokens: string[] }> = [
  { re: /\bin[\s_-]transit\b/i, tokens: ['in_transit', 'in transit'] },
  { re: /\bout[\s_-]for[\s_-]delivery\b/i, tokens: ['out_for_delivery', 'out for delivery'] },
  { re: /\bdelivered\b/i, tokens: ['delivered'] },
];

export interface GroundingContext {
  userMessages: string[];
  toolTexts: string[];
  /** Ticket IDs returned by successful create_support_ticket calls. */
  confirmedTicketIds: string[];
}

export function groundingContext(trace: CaseTrace): GroundingContext {
  return {
    userMessages: trace.turns.map((t) => t.user),
    toolTexts: trace.mcpCalls.map(toolResultText),
    confirmedTicketIds: trace.mcpCalls
      .filter((c) => c.tool === 'create_support_ticket' && toolSucceeded(c))
      .map((c) => String(toolPayload(c)?.ticket_id ?? ''))
      .filter(Boolean),
  };
}

/**
 * Flags facts in the response that are not supported by tool results or user input:
 * identifiers, dates, "City, ST" places, monetary amounts, and affirmative status claims.
 */
export function checkGrounding(scope: string, response: string, ctx: GroundingContext): AssertionResult[] {
  const corpus = [...ctx.userMessages, ...ctx.toolTexts].join('\n');
  const corpusLower = corpus.toLowerCase();
  const corpusDates = new Set(extractDates(corpus).map((x) => `${x.m}-${x.d}`));
  const unsupported: string[] = [];

  for (const id of response.match(/\b(SHP|EXC)-\d+\b/gi) ?? []) {
    if (!corpusLower.includes(id.toLowerCase())) unsupported.push(`identifier ${id}`);
  }
  for (const d of extractDates(response)) {
    // ±1 day tolerates timezone conversion of UTC timestamps.
    const near = [-1, 0, 1].some((delta) => {
      const dt = new Date(Date.UTC(2026, d.m - 1, d.d + delta));
      return corpusDates.has(`${dt.getUTCMonth() + 1}-${dt.getUTCDate()}`);
    });
    if (!near) unsupported.push(`date "${d.raw}"`);
  }
  for (const p of response.match(/\b[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*,\s[A-Z]{2}\b/g) ?? []) {
    if (!corpusLower.includes(p.toLowerCase())) unsupported.push(`place "${p}"`);
  }
  for (const money of response.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? []) {
    if (!corpus.includes(money.replace(/\s/g, ''))) unsupported.push(`amount ${money}`);
  }
  for (const s of sentences(response)) {
    if (NEGATION.test(s)) continue;
    for (const sp of STATUS_PHRASES) {
      if (sp.re.test(s) && !sp.tokens.some((t) => corpusLower.includes(t))) unsupported.push(`status claim "${s.slice(0, 80)}"`);
    }
  }
  return [
    {
      id: `${scope}:grounded`,
      category: 'factual-consistency',
      passed: unsupported.length === 0,
      message: unsupported.length ? `Unsupported facts in response: ${unsupported.join('; ')}` : 'All extracted facts are supported by tool results or user input',
      ...(unsupported.length ? { evidence: unsupported } : {}),
    },
  ];
}

const TICKET_CLAIM =
  /\b(ticket|case)\b[^.!?\n]{0,40}\b(has been|was|is now|is|got)\s+(successfully\s+)?(created|opened|filed|raised|submitted|logged)\b|\b(i|we)(\s+have|'ve)?\s+(successfully\s+)?(created|opened|filed|raised|submitted|logged)\b[^.!?\n]{0,40}\b(ticket|case)\b|\b(ticket|case)\s+(number|id|#)\b|\bTCK-\d+\b/i;

/** A ticket may only be claimed when create_support_ticket returned ok with that ticket_id. */
export function checkTicketClaims(scope: string, response: string, ctx: GroundingContext): AssertionResult[] {
  const confirmed = new Set(ctx.confirmedTicketIds.map((t) => t.toUpperCase()));
  const problems: string[] = [];
  for (const id of response.match(/\bTCK-\d+\b/gi) ?? []) {
    if (!confirmed.has(id.toUpperCase())) problems.push(`mentions ticket ${id} that no successful create_support_ticket call returned`);
  }
  if (confirmed.size === 0) {
    for (const s of sentences(response)) {
      if (TICKET_CLAIM.test(s) && !NEGATION.test(s)) problems.push(`claims a ticket exists: "${s.slice(0, 120)}"`);
    }
  }
  return [
    {
      id: `${scope}:noFalseTicketClaim`,
      category: 'factual-consistency',
      passed: problems.length === 0,
      message: problems.length ? problems.join('; ') : 'No unsupported ticket claims',
      ...(problems.length ? { evidence: problems } : {}),
    },
  ];
}

// ---------------------------------------------------------------- backend side effects

export function checkBackend(c: EvalCase, trace: CaseTrace): AssertionResult[] {
  const out: AssertionResult[] = [];
  const created = trace.tickets.length;
  if (c.expect.ticketsCreated !== undefined) {
    out.push({
      id: 'case:ticketsCreated',
      category: 'side-effects',
      passed: created === c.expect.ticketsCreated,
      message: `${created} ticket(s) created in backend (expected exactly ${c.expect.ticketsCreated})`,
      ...(created !== c.expect.ticketsCreated ? { evidence: trace.tickets } : {}),
    });
  }
  if (c.expect.maxTicketsCreated !== undefined) {
    out.push({
      id: 'case:maxTicketsCreated',
      category: 'side-effects',
      passed: created <= c.expect.maxTicketsCreated,
      message: `${created} ticket(s) created in backend (max ${c.expect.maxTicketsCreated})`,
    });
  }
  for (const [i, br] of c.expect.backendRequests.entries()) {
    const matching = trace.backendRequests.filter(
      (r) =>
        (!br.method || r.method === br.method) &&
        (!br.path || r.path === br.path) &&
        (!br.pathPattern || new RegExp(br.pathPattern).test(r.path)),
    );
    const n = matching.length;
    const label = `${br.method ?? '*'} ${br.path ?? br.pathPattern ?? '*'}`;
    const okMin = br.min === undefined || n >= br.min;
    const okMax = br.max === undefined || n <= br.max;
    out.push({
      id: `case:backend[${i}]:count`,
      category: 'retries',
      passed: okMin && okMax,
      message: `${n} backend request(s) to ${label} (expected ${br.min ?? 0}..${br.max ?? '∞'})`,
      ...(!okMin || !okMax ? { evidence: matching.map((r) => ({ path: r.path, status: r.status, outcome: r.outcome })) } : {}),
    });
    if (br.sameIdempotencyKey) {
      const keys = new Set(matching.map((r) => r.idempotencyKey));
      const ok = keys.size <= 1 && !keys.has(null);
      out.push({
        id: `case:backend[${i}]:sameIdempotencyKey`,
        category: 'side-effects',
        passed: ok,
        message: ok ? `All ${n} request(s) used one idempotency key` : `Idempotency keys differ or are missing: ${JSON.stringify([...keys])}`,
      });
    }
  }
  return out;
}

export function checkValidArguments(trace: CaseTrace): AssertionResult {
  const invalid = trace.mcpCalls.filter((c) => toolErrorCode(c) === 'INVALID_ARGUMENTS' || (c.rpcError as { code?: number } | null)?.code === -32602);
  return {
    id: 'case:validArguments',
    category: 'arguments',
    passed: invalid.length === 0,
    message: invalid.length ? `${invalid.length} MCP call(s) rejected for invalid arguments` : 'All MCP calls passed server-side input validation',
    ...(invalid.length ? { evidence: invalid.map((c) => ({ tool: c.tool, args: c.arguments, error: toolResultText(c).slice(0, 300) })) } : {}),
  };
}

// ---------------------------------------------------------------- orchestration

export function evaluateCase(c: EvalCase, trace: CaseTrace): AssertionResult[] {
  const results: AssertionResult[] = [];
  results.push({
    id: 'case:execution',
    category: 'execution',
    passed: trace.error === null && !trace.timedOut && trace.turns.length === c.turns.length,
    message: trace.timedOut
      ? `Case exceeded timeout of ${c.timeoutMs} ms`
      : trace.error
        ? `Agent execution failed: ${trace.error}`
        : `Completed ${trace.turns.length} turn(s)`,
  });

  results.push(...checkToolExpect('case', c.expect.toolCalls, trace.mcpCalls, trace.agentToolEvents));
  c.turns.forEach((turn, i) => {
    const t = trace.turns[i];
    if (!turn.expect || !t) return;
    if (turn.expect.toolCalls) results.push(...checkToolExpect(`turn${i + 1}`, turn.expect.toolCalls, t.mcpCalls, t.agentToolEvents));
    if (turn.expect.response) results.push(...checkResponseExpect(`turn${i + 1}`, turn.expect.response, t.response));
  });

  const last = trace.turns.at(-1);
  if (last) results.push(...checkResponseExpect('final', c.expect.response, last.response));

  const ctx = groundingContext(trace);
  trace.turns.forEach((t, i) => {
    if (c.expect.grounded) results.push(...checkGrounding(`turn${i + 1}`, t.response, ctx));
    if (c.expect.noFalseTicketClaim) results.push(...checkTicketClaims(`turn${i + 1}`, t.response, ctx));
  });

  results.push(...checkBackend(c, trace));
  if (c.expect.validArguments) results.push(checkValidArguments(trace));
  return results;
}
