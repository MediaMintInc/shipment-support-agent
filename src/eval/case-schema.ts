import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { FixtureSetSchema } from '../mock/fixtures.js';

/** Constraint on a single tool argument. Strings in `pattern` are case-insensitive regexes. */
export const ArgConstraintSchema = z.union([
  z.object({ equals: z.unknown() }).strict(),
  z.object({ pattern: z.string() }).strict(),
  z.object({ oneOf: z.array(z.unknown()).min(1) }).strict(),
  z.object({ present: z.boolean() }).strict(),
]);
export type ArgConstraint = z.infer<typeof ArgConstraintSchema>;

export const RequiredCallSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), ArgConstraintSchema).default({}),
  minCount: z.number().int().min(0).default(1),
  maxCount: z.number().int().min(0).optional(),
  /** Require the matching call to have returned ok (isError=false). */
  mustSucceed: z.boolean().default(false),
});

export const ResponseExpectSchema = z.object({
  /** Every regex must match the response (case-insensitive). Use alternation for paraphrases. */
  mustMentionAll: z.array(z.string()).default([]),
  /** At least one regex must match. */
  mustMentionAny: z.array(z.string()).default([]),
  /** Prohibited claims: none may match. */
  mustNotMention: z.array(z.string()).default([]),
});

export const ToolExpectSchema = z.object({
  required: z.array(RequiredCallSchema).default([]),
  /** Tools that must not be called at all. */
  forbidden: z.array(z.string()).default([]),
  /** Each pair [a, b]: the first `a` call must precede the first `b` call. Only for workflow-dependent order. */
  ordering: z.array(z.tuple([z.string(), z.string()])).default([]),
  /** Upper bound on attempted tool calls (agent-side, includes calls cancelled before reaching MCP). */
  maxToolCalls: z.number().int().min(0).optional(),
});

export const TurnSchema = z.object({
  user: z.string().min(1),
  /** Optional expectations scoped to this turn's tool calls and response. */
  expect: z
    .object({
      toolCalls: ToolExpectSchema.optional(),
      response: ResponseExpectSchema.optional(),
    })
    .optional(),
});

export const BackendRequestExpectSchema = z.object({
  method: z.enum(['GET', 'POST']).optional(),
  path: z.string().optional(),
  pathPattern: z.string().optional(),
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(0).optional(),
  /** All matching requests must carry the same idempotency key. */
  sameIdempotencyKey: z.boolean().optional(),
});

export const EvalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  /** Fixture files (relative to fixtures/) merged in order, then `fixtureOverrides`. */
  fixtures: z.array(z.string()).default(['base.yaml']),
  fixtureOverrides: FixtureSetSchema.partial().optional(),
  turns: z.array(TurnSchema).min(1),
  expect: z
    .object({
      toolCalls: ToolExpectSchema.default({ required: [], forbidden: [], ordering: [] }),
      /** Exact number of tickets the backend must have created (side effect). */
      ticketsCreated: z.number().int().min(0).optional(),
      maxTicketsCreated: z.number().int().min(0).optional(),
      backendRequests: z.array(BackendRequestExpectSchema).default([]),
      /** Applies to the final turn's response. */
      response: ResponseExpectSchema.default({ mustMentionAll: [], mustMentionAny: [], mustNotMention: [] }),
      /** Checks that shipment/ticket IDs, dates, places and statuses in responses come from tool data or the user. */
      grounded: z.boolean().default(true),
      /** Checks the agent does not claim a ticket exists unless create_support_ticket returned ok. */
      noFalseTicketClaim: z.boolean().default(true),
      /** Fails the case if any MCP call was rejected for invalid arguments. */
      validArguments: z.boolean().default(true),
    })
    .default({
      toolCalls: { required: [], forbidden: [], ordering: [] },
      backendRequests: [],
      response: { mustMentionAll: [], mustMentionAny: [], mustNotMention: [] },
      grounded: true,
      noFalseTicketClaim: true,
      validArguments: true,
    }),
  /** Optional rubric for the LLM judge (quality score only; never decides pass/fail). */
  qualityRubric: z.string().optional(),
  timeoutMs: z.number().int().min(1000).default(120_000),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type ToolExpect = z.infer<typeof ToolExpectSchema>;
export type ResponseExpect = z.infer<typeof ResponseExpectSchema>;

export function loadCases(dir: string): EvalCase[] {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const cases: EvalCase[] = [];
  for (const f of files) {
    const raw = parseYaml(readFileSync(path.join(dir, f), 'utf8')) as unknown;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const item of list) {
      const parsed = EvalCaseSchema.safeParse(item);
      if (!parsed.success) {
        throw new Error(`Invalid eval case in ${f}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      }
      cases.push(parsed.data);
    }
  }
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`Duplicate eval case id: ${c.id}`);
    ids.add(c.id);
  }
  return cases;
}
