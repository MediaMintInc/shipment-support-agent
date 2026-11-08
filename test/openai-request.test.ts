import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createShipmentAgent } from '../src/agent/agent.js';
import { createModel, providerHosts } from '../src/agent/model.js';
import { readAgentEnv } from '../src/config/env.js';
import { loadFixtureFile } from '../src/mock/fixtures.js';
import { MockBackend } from '../src/mock/server.js';

/**
 * OFFLINE CHECK OF THE OPENAI REQUEST SHAPE (no LLM, no network).
 *
 * The real Strands OpenAIModel is pointed at a local fake endpoint that records the request and
 * answers with an error. This verifies what would be sent to OpenAI: the four MCP tools with their
 * JSON schemas, model id, token limit, and that temperature is omitted unless configured.
 */
let fake: Server;
let fakeUrl = '';
const captured: Array<{ path: string; body: Record<string, unknown> }> = [];
const mock = new MockBackend();
let mockUrl = '';

beforeAll(async () => {
  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      captured.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fake endpoint: request captured', type: 'invalid_request_error', code: null, param: null } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  mockUrl = await mock.start(0);
  mock.loadFixtures(loadFixtureFile(path.resolve('fixtures/base.yaml')));
});
afterAll(async () => {
  fake.closeAllConnections();
  await new Promise<void>((r) => fake.close(() => r()));
  await mock.stop();
});
beforeEach(() => {
  captured.length = 0;
});

async function captureRequest(extraEnv: Record<string, string>) {
  const env = readAgentEnv({ MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-not-real', OPENAI_BASE_URL: fakeUrl, ...extraEnv });
  const { model, info } = await createModel(env);
  const handle = createShipmentAgent({
    model,
    env,
    serverEnv: { SHIPMENT_API_BASE_URL: `${mockUrl}/shipment-api`, SUPPORT_API_BASE_URL: `${mockUrl}/support-api` },
  });
  try {
    await expect(handle.agent.invoke('What is the status of SHP-100001?')).rejects.toThrow();
  } finally {
    await handle.close();
  }
  expect(captured).toHaveLength(1);
  return { req: captured[0]!, info, env };
}

const TOOL_NAMES = ['create_support_ticket', 'get_delivery_exceptions', 'get_shipment_status', 'get_tracking_history'];

describe('OpenAI request shape (offline, fake endpoint)', () => {
  it('defaults to the Responses API with MCP tools, no temperature', async () => {
    const { req, info, env } = await captureRequest({});
    expect(info).toEqual({ provider: 'openai', modelId: 'gpt-5.4' });
    expect(req.path).toBe('/v1/responses');
    const body = req.body;
    expect(body.model).toBe('gpt-5.4');
    expect(body.temperature).toBeUndefined();
    expect(body.max_output_tokens).toBe(4096);
    expect(body.store).toBe(false);
    const tools = body.tools as Array<{ type: string; name: string; parameters: { properties: Record<string, unknown>; required?: string[] } }>;
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    const ticket = tools.find((t) => t.name === 'create_support_ticket')!;
    expect(ticket.parameters.required).toEqual(expect.arrayContaining(['shipment_id', 'user_explicitly_requested']));
    expect(ticket.parameters.properties).toHaveProperty('idempotency_key');
    expect(JSON.stringify(body.instructions ?? body.input)).toMatch(/shipment support assistant/);
    expect(providerHosts(env)).toEqual(['127.0.0.1']);
  });

  it('supports Chat Completions, explicit temperature and reasoning effort', async () => {
    const { req } = await captureRequest({ OPENAI_API_MODE: 'chat', MODEL_ID: 'gpt-5.4-mini', MODEL_TEMPERATURE: '0.2', OPENAI_REASONING_EFFORT: 'low' });
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.body).toMatchObject({ model: 'gpt-5.4-mini', temperature: 0.2, reasoning_effort: 'low', max_completion_tokens: 4096 });
    const tools = req.body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t.function.name).sort()).toEqual(TOOL_NAMES);
  });

  it('passes reasoning effort on the Responses API', async () => {
    const { req } = await captureRequest({ OPENAI_REASONING_EFFORT: 'medium' });
    expect(req.body.reasoning).toMatchObject({ effort: 'medium' });
  });
});
