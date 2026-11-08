import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Fixture model for the deterministic mock backend. Shipment records use the backend wire
 * format; `faults` script failure behaviour for matching requests.
 */

export const FaultResponseSchema = z.discriminatedUnion('type', [
  /** Respond with an HTTP error status (e.g. 500, 503). */
  z.object({ type: z.literal('http_error'), status: z.number().int().min(400).max(599), body: z.string().optional() }),
  /** Respond with HTTP 429 and an optional Retry-After header. */
  z.object({ type: z.literal('rate_limit'), retryAfterSeconds: z.number().int().min(0).default(0) }),
  /** Hold the request for `delayMs` before responding normally (clients with shorter timeouts abort). */
  z.object({ type: z.literal('timeout'), delayMs: z.number().int().min(1).default(30_000) }),
  /** Respond 200 with a body that is not valid JSON (`raw`) or JSON that violates the contract (`json`). */
  z.object({ type: z.literal('malformed'), raw: z.string().optional(), json: z.unknown().optional() }),
  /** Perform the request's side effect (e.g. create the ticket) and then respond with an error status. */
  z.object({ type: z.literal('commit_then_error'), status: z.number().int().min(500).max(599).default(503) }),
]);
export type FaultResponse = z.infer<typeof FaultResponseSchema>;

export const FaultSchema = z.object({
  match: z.object({
    method: z.enum(['GET', 'POST']).optional(),
    /** Exact path match, e.g. "/shipment-api/v1/shipments/SHP-100001". */
    path: z.string().optional(),
    /** Regular expression tested against the path. */
    pathPattern: z.string().optional(),
  }),
  /** Responses consumed in order for successive matching requests. */
  responses: z.array(FaultResponseSchema).min(1),
  /** When true, the last response repeats forever once the list is exhausted. */
  repeatLast: z.boolean().default(false),
});
export type Fault = z.infer<typeof FaultSchema>;

/**
 * Shipment records are intentionally loose (`unknown`) so fixtures can contain malformed data
 * that the adapters must reject.
 */
export const ShipmentFixtureSchema = z.object({
  status: z.unknown().optional(),
  events: z.unknown().optional(),
  exceptions: z.unknown().optional(),
});

export const FixtureSetSchema = z.object({
  shipments: z.record(z.string(), ShipmentFixtureSchema).default({}),
  faults: z.array(FaultSchema).default([]),
});
export type FixtureSet = z.infer<typeof FixtureSetSchema>;
export type FixtureSetInput = z.input<typeof FixtureSetSchema>;

export function loadFixtureFile(file: string): FixtureSet {
  const raw = parseYaml(readFileSync(file, 'utf8')) as unknown;
  return FixtureSetSchema.parse(raw);
}

/** Merges fixture sets left-to-right: later shipments replace earlier ones by ID; faults append. */
export function mergeFixtures(...sets: FixtureSetInput[]): FixtureSet {
  const out: FixtureSet = { shipments: {}, faults: [] };
  for (const s of sets) {
    const parsed = FixtureSetSchema.parse(s);
    Object.assign(out.shipments, parsed.shipments);
    out.faults.push(...parsed.faults);
  }
  return out;
}

export function resolveFixturePath(baseDir: string, ref: string): string {
  return path.isAbsolute(ref) ? ref : path.join(baseDir, ref);
}
