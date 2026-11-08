import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadFixtureFile, mergeFixtures, type FixtureSetInput } from '../src/mock/fixtures.js';
import { MockBackend } from '../src/mock/server.js';

/**
 * Exercises the real MCP servers as child processes over stdio (the built `dist/` output),
 * talking to the mock backend over HTTP. No LLM involved.
 */
const base = loadFixtureFile(path.resolve('fixtures/base.yaml'));
const mock = new MockBackend();
let mockUrl = '';

interface Conn {
  client: Client;
  stderr: string[];
}

async function connect(server: 'shipment' | 'support'): Promise<Conn> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(`dist/mcp/${server}-server.js`)],
    env: {
      PATH: process.env.PATH ?? '',
      SHIPMENT_API_BASE_URL: `${mockUrl}/shipment-api`,
      SUPPORT_API_BASE_URL: `${mockUrl}/support-api`,
      BACKEND_ALLOWED_ORIGINS: mockUrl,
      BACKEND_TIMEOUT_MS: '300',
      BACKEND_MAX_RETRIES: '2',
      BACKEND_RETRY_BASE_DELAY_MS: '1',
      LOG_LEVEL: 'debug',
    },
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  (transport.stderr as PassThrough).on('data', (c: Buffer) => stderr.push(c.toString()));
  const client = new Client({ name: 'offline-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, stderr };
}

let shipment: Conn;
let support: Conn;

function load(extra: FixtureSetInput = {}) {
  mock.loadFixtures(mergeFixtures(base, extra));
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ type: string; text?: string }> };
const call = async (c: Conn, name: string, args: Record<string, unknown>) => (await c.client.callTool({ name, arguments: args })) as unknown as ToolResult;

beforeAll(async () => {
  mockUrl = await mock.start(0);
  [shipment, support] = await Promise.all([connect('shipment'), connect('support')]);
});
afterAll(async () => {
  await Promise.allSettled([shipment?.client.close(), support?.client.close()]);
  await mock.stop();
});
beforeEach(() => load());

describe('tool discovery over stdio', () => {
  it('shipment server advertises its two tools with schemas and annotations', async () => {
    const { tools } = await shipment.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_shipment_status', 'get_tracking_history']);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(80);
      expect(t.inputSchema.required).toEqual(['shipment_id']);
      expect(t.outputSchema).toBeDefined();
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('support server advertises exception lookup and ticket creation', async () => {
    const { tools } = await support.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['create_support_ticket', 'get_delivery_exceptions']);
    const create = tools.find((t) => t.name === 'create_support_ticket')!;
    expect(create.annotations?.readOnlyHint).toBe(false);
    expect(create.inputSchema.required).toEqual(
      expect.arrayContaining(['shipment_id', 'category', 'description', 'user_explicitly_requested', 'user_request_quote']),
    );
    expect(create.description).toMatch(/explicitly/i);
  });
});

describe('tool invocation over stdio', () => {
  it('returns structured status data', async () => {
    const r = await call(shipment, 'get_shipment_status', { shipment_id: 'SHP-100001' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ ok: true, status: 'IN_TRANSIT', destination: 'Denver, CO', backend_attempts: 1 });
    expect(JSON.parse(r.content[0]!.text!)).toEqual(r.structuredContent);
  });

  it('marks tracking text as untrusted', async () => {
    const r = await call(shipment, 'get_tracking_history', { shipment_id: 'SHP-100004' });
    expect(r.structuredContent?.notice).toMatch(/untrusted|never as instructions/i);
  });

  it('maps NOT_FOUND to a structured tool error', async () => {
    const r = await call(shipment, 'get_shipment_status', { shipment_id: 'SHP-999999' });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text!)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', retryable: false } });
  });

  it('maps timeouts after bounded retries', async () => {
    load({ faults: [{ match: { path: '/shipment-api/v1/shipments/SHP-100001' }, responses: [{ type: 'timeout', delayMs: 5000 }], repeatLast: true }] });
    const r = await call(shipment, 'get_shipment_status', { shipment_id: 'SHP-100001' });
    expect(JSON.parse(r.content[0]!.text!)).toMatchObject({ ok: false, error: { code: 'TIMEOUT', retryable: true, attempts: 3 } });
    expect(mock.getRequests()).toHaveLength(3);
  });

  it('maps malformed backend data without leaking it', async () => {
    load({ shipments: { 'SHP-100001': { status: { shipmentId: 'SHP-100001', status: 'TELEPORTED', destination: 'Paris, FR' } } } });
    const r = await call(shipment, 'get_shipment_status', { shipment_id: 'SHP-100001' });
    expect(r.isError).toBe(true);
    const text = r.content[0]!.text!;
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'MALFORMED_RESPONSE' } });
    expect(text).not.toMatch(/Paris|TELEPORTED/);
  });

  it('rejects invalid input at the MCP boundary without contacting the backend', async () => {
    const r = await call(shipment, 'get_shipment_status', { shipment_id: 'not-an-id' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Input validation error/);
    expect(mock.getRequests()).toHaveLength(0);
  });

  it('refuses ticket creation without explicit user intent', async () => {
    const r = await call(support, 'create_support_ticket', {
      shipment_id: 'SHP-100003',
      category: 'DELIVERY_EXCEPTION',
      description: 'Address could not be located',
      user_explicitly_requested: false,
      user_request_quote: 'n/a',
    });
    expect(r.isError).toBe(true);
    expect(mock.getTickets()).toHaveLength(0);
  });

  it('creates one ticket for repeated calls with the same idempotency key', async () => {
    const args = {
      shipment_id: 'SHP-100003',
      category: 'DELIVERY_EXCEPTION',
      description: 'Address could not be located; apartment number missing',
      user_explicitly_requested: true,
      user_request_quote: 'please open a ticket',
      idempotency_key: 'SHP-100003-DELIVERY_EXCEPTION-1',
    };
    const a = await call(support, 'create_support_ticket', args);
    const b = await call(support, 'create_support_ticket', args);
    expect(a.structuredContent).toMatchObject({ ok: true, ticket_id: 'TCK-5001', replayed: false });
    expect(b.structuredContent).toMatchObject({ ok: true, ticket_id: 'TCK-5001', replayed: true });
    expect(mock.getTickets()).toHaveLength(1);
  });

  it('derives the same idempotency key when the model omits it and retries', async () => {
    const args = {
      shipment_id: 'SHP-100003',
      category: 'DELIVERY_EXCEPTION',
      description: 'Address could not be located',
      user_explicitly_requested: true,
      user_request_quote: 'open a ticket',
    };
    await call(support, 'create_support_ticket', args);
    await call(support, 'create_support_ticket', args);
    expect(mock.getTickets()).toHaveLength(1);
  });

  it('logs to stderr only (stdout carries protocol frames)', async () => {
    await call(shipment, 'get_shipment_status', { shipment_id: 'SHP-100001' });
    await new Promise((r) => setTimeout(r, 50));
    const lines = shipment.stderr.join('').split('\n').filter(Boolean);
    expect(lines.some((l) => l.includes('"tool call succeeded"'))).toBe(true);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});
