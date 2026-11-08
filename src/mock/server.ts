import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FixtureSetSchema, type Fault, type FaultResponse, type FixtureSet } from './fixtures.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('mock-backend');

/**
 * Deterministic mock of the shipment and support backends.
 *
 *   /shipment-api/v1/shipments/{id}             GET  shipment status
 *   /shipment-api/v1/shipments/{id}/events      GET  tracking history
 *   /support-api/v1/shipments/{id}/exceptions   GET  delivery exceptions
 *   /support-api/v1/tickets                     POST create ticket (Idempotency-Key header required)
 *
 * Admin API (used by the eval harness and tests, never by adapters):
 *   GET  /__admin/health
 *   POST /__admin/reset                  clear fixtures, faults, tickets and recorded requests
 *   PUT  /__admin/fixtures               load a fixture set (+ optional correlation context); clears state
 *   GET  /__admin/requests               recorded backend requests
 *   GET  /__admin/tickets                tickets created (backend side effects)
 */

export interface RecordedRequest {
  seq: number;
  ts: string;
  runId: string | null;
  caseId: string | null;
  method: string;
  path: string;
  idempotencyKey: string | null;
  body: unknown;
  status: number | null;
  outcome: string;
  durationMs: number;
}

export interface TicketRecord {
  ticketId: string;
  shipmentId: string;
  status: 'OPEN';
  category: string;
  description: string;
  createdAt: string;
  idempotencyKey: string;
}

interface FaultState {
  fault: Fault;
  consumed: number;
}

/** Fixed clock so ticket timestamps are deterministic across runs. */
const FIXED_NOW = '2026-11-07T12:00:00Z';

export class MockBackend {
  private server: Server | undefined;
  private fixtures: FixtureSet = { shipments: {}, faults: [] };
  private faults: FaultState[] = [];
  private requests: RecordedRequest[] = [];
  private tickets = new Map<string, TicketRecord>();
  private ticketSeq = 5000;
  private seq = 0;
  private context: { runId: string | null; caseId: string | null } = { runId: null, caseId: null };
  private readonly pendingTimers = new Set<NodeJS.Timeout>();

  async start(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log.error('handler crashed', { error: String(err) });
        if (!res.headersSent) this.json(res, 500, { error: 'mock crashed' });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    const addr = this.server.address() as AddressInfo;
    const url = `http://${host}:${addr.port}`;
    log.info('mock backend listening', { url });
    return url;
  }

  async stop(): Promise<void> {
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers.clear();
    const srv = this.server;
    this.server = undefined;
    if (!srv) return;
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  // ---- state management (also exposed over the admin API) ----

  reset(): void {
    this.fixtures = { shipments: {}, faults: [] };
    this.faults = [];
    this.requests = [];
    this.tickets.clear();
    this.ticketSeq = 5000;
    this.seq = 0;
    this.context = { runId: null, caseId: null };
  }

  loadFixtures(set: unknown, context?: { runId?: string; caseId?: string }): void {
    this.reset();
    this.fixtures = FixtureSetSchema.parse(set);
    this.faults = this.fixtures.faults.map((fault) => ({ fault, consumed: 0 }));
    this.context = { runId: context?.runId ?? null, caseId: context?.caseId ?? null };
  }

  getRequests(): RecordedRequest[] {
    return this.requests.map((r) => ({ ...r }));
  }

  getTickets(): TicketRecord[] {
    return [...this.tickets.values()].map((t) => ({ ...t }));
  }

  // ---- HTTP handling ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mock');
    const method = (req.method ?? 'GET').toUpperCase();
    const body = await readBody(req);

    if (url.pathname.startsWith('/__admin/')) return this.handleAdmin(method, url.pathname, body, res);

    const started = Date.now();
    const rec: RecordedRequest = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      runId: this.context.runId,
      caseId: this.context.caseId,
      method,
      path: url.pathname,
      idempotencyKey: headerValue(req, 'idempotency-key'),
      body: tryJson(body),
      status: null,
      outcome: 'pending',
      durationMs: 0,
    };
    this.requests.push(rec);
    const finish = (status: number | null, outcome: string) => {
      rec.status = status;
      rec.outcome = outcome;
      rec.durationMs = Date.now() - started;
    };

    const fault = this.nextFault(method, url.pathname);
    if (fault) {
      switch (fault.type) {
        case 'http_error':
          finish(fault.status, `fault:http_error`);
          return this.json(res, fault.status, { error: fault.body ?? 'injected failure' });
        case 'rate_limit':
          finish(429, 'fault:rate_limit');
          res.setHeader('retry-after', String(fault.retryAfterSeconds));
          return this.json(res, 429, { error: 'rate limited' });
        case 'malformed':
          finish(200, 'fault:malformed');
          if (fault.raw !== undefined) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(fault.raw);
            return;
          }
          return this.json(res, 200, fault.json ?? {});
        case 'timeout': {
          const closed = await this.delay(fault.delayMs, res);
          if (closed) {
            finish(null, 'fault:timeout(client aborted)');
            return;
          }
          // Client waited it out: fall through to the normal response.
          break;
        }
        case 'commit_then_error': {
          const result = this.route(method, url.pathname, req, body);
          finish(fault.status, `fault:commit_then_error(committed ${result.status})`);
          return this.json(res, fault.status, { error: 'injected failure after commit' });
        }
      }
    }

    const result = this.route(method, url.pathname, req, body);
    finish(result.status, fault?.type === 'timeout' ? 'fault:timeout(served late)' : 'ok');
    if (result.raw !== undefined) {
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(result.raw);
      return;
    }
    this.json(res, result.status, result.body);
  }

  private route(method: string, pathname: string, req: IncomingMessage, rawBody: string): { status: number; body?: unknown; raw?: string } {
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = pathname.match(/^\/shipment-api\/v1\/shipments\/([^/]+)$/))) {
      return this.fixtureField(decodeURIComponent(m[1]!), 'status');
    }
    if (method === 'GET' && (m = pathname.match(/^\/shipment-api\/v1\/shipments\/([^/]+)\/events$/))) {
      return this.fixtureField(decodeURIComponent(m[1]!), 'events');
    }
    if (method === 'GET' && (m = pathname.match(/^\/support-api\/v1\/shipments\/([^/]+)\/exceptions$/))) {
      return this.fixtureField(decodeURIComponent(m[1]!), 'exceptions');
    }
    if (method === 'POST' && pathname === '/support-api/v1/tickets') {
      return this.createTicket(req, rawBody);
    }
    return { status: 404, body: { error: 'no such route' } };
  }

  private fixtureField(id: string, field: 'status' | 'events' | 'exceptions'): { status: number; body?: unknown; raw?: string } {
    const shipment = this.fixtures.shipments[id];
    if (!shipment) return { status: 404, body: { error: `shipment ${id} not found` } };
    const value = shipment[field];
    if (field === 'events' && value === undefined) return { status: 200, body: { shipmentId: id, events: [] } };
    if (field === 'exceptions' && value === undefined) return { status: 200, body: { shipmentId: id, exceptions: [] } };
    if (value === undefined) return { status: 404, body: { error: `no ${field} for ${id}` } };
    // Raw strings let fixtures serve non-JSON bodies.
    if (typeof value === 'string') return { status: 200, raw: value };
    if (field === 'events' && Array.isArray(value)) return { status: 200, body: { shipmentId: id, events: value } };
    if (field === 'exceptions' && Array.isArray(value)) return { status: 200, body: { shipmentId: id, exceptions: value } };
    return { status: 200, body: value };
  }

  private createTicket(req: IncomingMessage, rawBody: string): { status: number; body: unknown } {
    const key = headerValue(req, 'idempotency-key');
    if (!key) return { status: 400, body: { error: 'Idempotency-Key header is required' } };
    const existing = this.tickets.get(key);
    if (existing) return { status: 200, body: publicTicket(existing) };

    const body = tryJson(rawBody) as { shipmentId?: unknown; category?: unknown; description?: unknown } | null;
    if (!body || typeof body.shipmentId !== 'string' || typeof body.category !== 'string' || typeof body.description !== 'string') {
      return { status: 400, body: { error: 'shipmentId, category and description are required' } };
    }
    if (!this.fixtures.shipments[body.shipmentId]) return { status: 404, body: { error: 'unknown shipment' } };

    const ticket: TicketRecord = {
      ticketId: `TCK-${++this.ticketSeq}`,
      shipmentId: body.shipmentId,
      status: 'OPEN',
      category: body.category,
      description: body.description,
      createdAt: FIXED_NOW,
      idempotencyKey: key,
    };
    this.tickets.set(key, ticket);
    return { status: 201, body: publicTicket(ticket) };
  }

  private nextFault(method: string, pathname: string): FaultResponse | undefined {
    for (const fs of this.faults) {
      const { match } = fs.fault;
      if (match.method && match.method !== method) continue;
      if (match.path && match.path !== pathname) continue;
      if (match.pathPattern && !new RegExp(match.pathPattern).test(pathname)) continue;
      const list = fs.fault.responses;
      if (fs.consumed < list.length) return list[fs.consumed++];
      if (fs.fault.repeatLast) return list[list.length - 1];
    }
    return undefined;
  }

  /** Waits `ms`, resolving early with `true` if the client disconnects. */
  private delay(ms: number, res: ServerResponse): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        res.off('close', onClose);
        resolve(false);
      }, ms);
      this.pendingTimers.add(timer);
      const onClose = () => {
        if (res.writableEnded) return;
        clearTimeout(timer);
        this.pendingTimers.delete(timer);
        resolve(true);
      };
      res.on('close', onClose);
    });
  }

  private handleAdmin(method: string, pathname: string, body: string, res: ServerResponse): void {
    try {
      if (method === 'GET' && pathname === '/__admin/health') return this.json(res, 200, { ok: true });
      if (method === 'POST' && pathname === '/__admin/reset') {
        this.reset();
        return this.json(res, 200, { ok: true });
      }
      if (method === 'PUT' && pathname === '/__admin/fixtures') {
        const parsed = JSON.parse(body) as { fixtures: unknown; context?: { runId?: string; caseId?: string } };
        this.loadFixtures(parsed.fixtures, parsed.context);
        return this.json(res, 200, { ok: true });
      }
      if (method === 'GET' && pathname === '/__admin/requests') return this.json(res, 200, { requests: this.getRequests() });
      if (method === 'GET' && pathname === '/__admin/tickets') return this.json(res, 200, { tickets: this.getTickets() });
      return this.json(res, 404, { error: 'unknown admin route' });
    } catch (err) {
      return this.json(res, 400, { error: String((err as Error).message ?? err) });
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

function publicTicket(t: TicketRecord) {
  return { ticketId: t.ticketId, shipmentId: t.shipmentId, status: t.status, category: t.category, createdAt: t.createdAt };
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function tryJson(s: string): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
