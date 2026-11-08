import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveIdempotencyKey, ShipmentAdapter, SupportAdapter } from '../src/backend/adapters.js';
import { BackendError } from '../src/backend/errors.js';
import { BackendHttpClient } from '../src/backend/http.js';
import { BackendShipmentSchema, ShipmentIdSchema } from '../src/backend/schemas.js';
import { readBackendEnv } from '../src/config/env.js';
import { loadFixtureFile, mergeFixtures, type FixtureSetInput } from '../src/mock/fixtures.js';
import { MockBackend } from '../src/mock/server.js';

const base = loadFixtureFile(path.resolve('fixtures/base.yaml'));
const mock = new MockBackend();
let url = '';

function adapters(overrides: Record<string, string> = {}) {
  const env = readBackendEnv({
    SHIPMENT_API_BASE_URL: `${url}/shipment-api`,
    SUPPORT_API_BASE_URL: `${url}/support-api`,
    BACKEND_TIMEOUT_MS: '300',
    BACKEND_MAX_RETRIES: '2',
    BACKEND_RETRY_BASE_DELAY_MS: '1',
    BACKEND_RETRY_MAX_DELAY_MS: '5',
    BACKEND_ALLOWED_ORIGINS: url,
    ...overrides,
  });
  return { shipment: ShipmentAdapter.fromEnv(env), support: SupportAdapter.fromEnv(env) };
}

function load(extra: FixtureSetInput = {}) {
  mock.loadFixtures(mergeFixtures(base, extra));
}

async function expectBackendError(p: Promise<unknown>, code: string, attempts?: number) {
  const err = await p.then(
    () => {
      throw new Error('expected failure');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BackendError);
  expect((err as BackendError).code).toBe(code);
  if (attempts !== undefined) expect((err as BackendError).attempts).toBe(attempts);
  return err as BackendError;
}

beforeAll(async () => {
  url = await mock.start(0);
});
afterAll(async () => {
  await mock.stop();
});
beforeEach(() => load());

describe('input validation', () => {
  it('normalises and accepts valid shipment ids', () => {
    expect(ShipmentIdSchema.parse(' shp-100001 ')).toBe('SHP-100001');
  });
  it.each(['', 'SHP-1', '100001', 'SHP-ABCDEF', 'SHP-100001; DROP TABLE', '../SHP-100001'])('rejects %j', (id) => {
    expect(ShipmentIdSchema.safeParse(id).success).toBe(false);
  });
  it('rejects backend payloads that violate the contract', () => {
    expect(BackendShipmentSchema.safeParse({ shipmentId: 'SHP-1', status: 'TELEPORTED' }).success).toBe(false);
  });
});

describe('ShipmentAdapter', () => {
  it('maps a successful status response', async () => {
    const { data, meta } = await adapters().shipment.getStatus('SHP-100001');
    expect(data).toMatchObject({ shipment_id: 'SHP-100001', status: 'IN_TRANSIT', destination: 'Denver, CO', estimated_delivery: '2026-11-10' });
    expect(meta.attempts).toBe(1);
  });

  it('returns tracking events in chronological order', async () => {
    const { data } = await adapters().shipment.getTrackingHistory('SHP-100001');
    const ts = data.events.map((e) => e.timestamp);
    expect(ts).toEqual([...ts].sort());
    expect(data.events).toHaveLength(4);
  });

  it('maps 404 to NOT_FOUND without retrying', async () => {
    await expectBackendError(adapters().shipment.getStatus('SHP-999999'), 'NOT_FOUND', 1);
    expect(mock.getRequests()).toHaveLength(1);
  });

  it('retries transient 503s within the configured limit and then succeeds', async () => {
    load({ faults: [{ match: { path: '/shipment-api/v1/shipments/SHP-100001' }, responses: [{ type: 'http_error', status: 503 }, { type: 'http_error', status: 503 }] }] });
    const { meta } = await adapters().shipment.getStatus('SHP-100001');
    expect(meta.attempts).toBe(3);
    expect(mock.getRequests()).toHaveLength(3);
  });

  it('stops after max retries on persistent failure (bounded retries)', async () => {
    load({ faults: [{ match: { path: '/shipment-api/v1/shipments/SHP-100001' }, responses: [{ type: 'http_error', status: 500 }], repeatLast: true }] });
    await expectBackendError(adapters().shipment.getStatus('SHP-100001'), 'UPSTREAM_ERROR', 3);
    expect(mock.getRequests()).toHaveLength(3);
  });

  it('honours BACKEND_MAX_RETRIES=0', async () => {
    load({ faults: [{ match: { path: '/shipment-api/v1/shipments/SHP-100001' }, responses: [{ type: 'http_error', status: 503 }], repeatLast: true }] });
    await expectBackendError(adapters({ BACKEND_MAX_RETRIES: '0' }).shipment.getStatus('SHP-100001'), 'UPSTREAM_ERROR', 1);
    expect(mock.getRequests()).toHaveLength(1);
  });

  it('times out each attempt and gives up after bounded retries', async () => {
    load({ faults: [{ match: { path: '/shipment-api/v1/shipments/SHP-100001' }, responses: [{ type: 'timeout', delayMs: 5000 }], repeatLast: true }] });
    const t0 = Date.now();
    await expectBackendError(adapters().shipment.getStatus('SHP-100001'), 'TIMEOUT', 3);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(mock.getRequests()).toHaveLength(3);
  });

  it('retries after a 429 rate limit', async () => {
    load({ faults: [{ match: { path: '/shipment-api/v1/shipments/SHP-100002' }, responses: [{ type: 'rate_limit', retryAfterSeconds: 0 }] }] });
    const { data, meta } = await adapters().shipment.getStatus('SHP-100002');
    expect(data.status).toBe('DELIVERED');
    expect(meta.attempts).toBe(2);
  });

  it('reports RATE_LIMITED when the limit persists', async () => {
    load({ faults: [{ match: { path: '/shipment-api/v1/shipments/SHP-100002' }, responses: [{ type: 'rate_limit', retryAfterSeconds: 0 }], repeatLast: true }] });
    await expectBackendError(adapters().shipment.getStatus('SHP-100002'), 'RATE_LIMITED', 3);
  });

  it('maps non-JSON bodies to MALFORMED_RESPONSE without retrying', async () => {
    load({ faults: [{ match: { path: '/shipment-api/v1/shipments/SHP-100001' }, responses: [{ type: 'malformed', raw: '<html>oops' }] }] });
    await expectBackendError(adapters().shipment.getStatus('SHP-100001'), 'MALFORMED_RESPONSE', 1);
    expect(mock.getRequests()).toHaveLength(1);
  });

  it('maps schema-violating JSON to MALFORMED_RESPONSE', async () => {
    load({ shipments: { 'SHP-100001': { status: { shipmentId: 'SHP-100001', status: 'TELEPORTED' } } } });
    const err = await expectBackendError(adapters().shipment.getStatus('SHP-100001'), 'MALFORMED_RESPONSE');
    expect(err.message).toMatch(/schema validation/);
  });

  it('refuses destinations outside BACKEND_ALLOWED_ORIGINS before sending anything', async () => {
    const { shipment } = adapters({ BACKEND_ALLOWED_ORIGINS: 'http://127.0.0.1:1' });
    await expectBackendError(shipment.getStatus('SHP-100001'), 'DESTINATION_NOT_ALLOWED');
    expect(mock.getRequests()).toHaveLength(0);
  });

  it('refuses redirects instead of following them past the allow-list', async () => {
    const { createServer } = await import('node:http');
    let hitsOnTarget = 0;
    const target = createServer((_req, res) => {
      hitsOnTarget++;
      res.end('{}');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `${targetUrl}/v1/shipments/SHP-100001` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', () => r()));
    const redirectorUrl = `http://127.0.0.1:${(redirector.address() as { port: number }).port}`;
    try {
      const shipment = ShipmentAdapter.fromEnv(
        readBackendEnv({ SHIPMENT_API_BASE_URL: redirectorUrl, BACKEND_ALLOWED_ORIGINS: redirectorUrl, BACKEND_RETRY_BASE_DELAY_MS: '1' }),
      );
      await expectBackendError(shipment.getStatus('SHP-100001'), 'DESTINATION_NOT_ALLOWED', 1);
      expect(hitsOnTarget).toBe(0);
    } finally {
      target.closeAllConnections();
      redirector.closeAllConnections();
      await Promise.all([new Promise((r) => target.close(r)), new Promise((r) => redirector.close(r))]);
    }
  });

  it('maps connection failures to NETWORK_ERROR after retries', async () => {
    const http = new BackendHttpClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 200, maxRetries: 1, retryBaseDelayMs: 1, retryMaxDelayMs: 1 });
    const { BackendExceptionsSchema } = await import('../src/backend/schemas.js');
    await expectBackendError(http.request({ method: 'GET', path: '/x', schema: BackendExceptionsSchema, retryable: true }), 'NETWORK_ERROR', 2);
  });
});

describe('SupportAdapter', () => {
  it('returns delivery exceptions', async () => {
    const { data } = await adapters().support.getDeliveryExceptions('SHP-100003');
    expect(data.exceptions).toEqual([
      expect.objectContaining({ exception_id: 'EXC-7001', type: 'ADDRESS_ISSUE', resolution_status: 'OPEN' }),
    ]);
  });

  it('returns an empty list when a shipment has no exceptions', async () => {
    const { data } = await adapters().support.getDeliveryExceptions('SHP-100001');
    expect(data.exceptions).toEqual([]);
  });

  const ticket = { shipment_id: 'SHP-100003', category: 'DELIVERY_EXCEPTION' as const, description: 'Address could not be located', idempotency_key: 'key-test-0001' };

  it('creates a ticket and replays it for the same idempotency key', async () => {
    const { support } = adapters();
    const first = await support.createTicket(ticket);
    const second = await support.createTicket(ticket);
    expect(first.data).toMatchObject({ ticket_id: 'TCK-5001', replayed: false });
    expect(second.data).toMatchObject({ ticket_id: 'TCK-5001', replayed: true });
    expect(mock.getTickets()).toHaveLength(1);
  });

  it('retries a committed-but-failed POST with the same key and creates exactly one ticket', async () => {
    load({ faults: [{ match: { method: 'POST', path: '/support-api/v1/tickets' }, responses: [{ type: 'commit_then_error', status: 503 }] }] });
    const { data, meta } = await adapters().support.createTicket(ticket);
    expect(meta.attempts).toBe(2);
    expect(data).toMatchObject({ ticket_id: 'TCK-5001', replayed: true });
    expect(mock.getTickets()).toHaveLength(1);
    const posts = mock.getRequests().filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => p.idempotencyKey))).toEqual(new Set(['key-test-0001']));
  });

  it('retries a timed-out POST safely (one side effect)', async () => {
    load({ faults: [{ match: { method: 'POST', path: '/support-api/v1/tickets' }, responses: [{ type: 'timeout', delayMs: 1000 }] }] });
    const { data } = await adapters().support.createTicket(ticket);
    expect(data.ticket_id).toBe('TCK-5001');
    // Give the late first request time to complete on the server side.
    await new Promise((r) => setTimeout(r, 1100));
    expect(mock.getTickets()).toHaveLength(1);
  });

  it('derives stable idempotency keys from ticket content', () => {
    const a = deriveIdempotencyKey('shp-100003', 'DAMAGE', '  Box  crushed ');
    const b = deriveIdempotencyKey('SHP-100003', 'DAMAGE', 'box crushed');
    const c = deriveIdempotencyKey('SHP-100003', 'DAMAGE', 'different issue');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
