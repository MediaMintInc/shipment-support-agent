import { createHash } from 'node:crypto';
import { BackendHttpClient, parseAllowedOrigins, type HttpClientOptions } from './http.js';
import {
  BackendExceptionsSchema,
  BackendShipmentSchema,
  BackendTicketSchema,
  BackendTrackingSchema,
  type TicketCategoryValues,
} from './schemas.js';
import type { BackendEnv } from '../config/env.js';

/**
 * Backend adapters: the only layer that knows backend URLs and wire formats.
 * They map backend payloads (camelCase) to the domain shapes returned by MCP tools.
 */

export interface ShipmentStatus {
  shipment_id: string;
  status: string;
  carrier: string;
  origin: string;
  destination: string;
  estimated_delivery: string | null;
  last_updated: string;
}

export interface TrackingEvent {
  timestamp: string;
  location: string;
  code: string;
  description: string;
}

export interface DeliveryException {
  exception_id: string;
  type: string;
  description: string;
  occurred_at: string;
  resolution_status: string;
}

export interface SupportTicket {
  ticket_id: string;
  shipment_id: string;
  status: string;
  category: string;
  created_at: string;
  /** True when the backend recognised the idempotency key and returned the existing ticket. */
  replayed: boolean;
}

export interface CallMeta {
  attempts: number;
}

function clientOptions(env: BackendEnv, baseUrl: string, overrides?: Partial<HttpClientOptions>): HttpClientOptions {
  const allowedOrigins = parseAllowedOrigins(env.BACKEND_ALLOWED_ORIGINS);
  return {
    baseUrl,
    timeoutMs: env.BACKEND_TIMEOUT_MS,
    maxRetries: env.BACKEND_MAX_RETRIES,
    retryBaseDelayMs: env.BACKEND_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: env.BACKEND_RETRY_MAX_DELAY_MS,
    ...(allowedOrigins ? { allowedOrigins } : {}),
    ...(env.BACKEND_API_TOKEN ? { apiToken: env.BACKEND_API_TOKEN } : {}),
    ...overrides,
  };
}

export class ShipmentAdapter {
  constructor(private readonly http: BackendHttpClient) {}

  static fromEnv(env: BackendEnv, overrides?: Partial<HttpClientOptions>): ShipmentAdapter {
    return new ShipmentAdapter(new BackendHttpClient(clientOptions(env, env.SHIPMENT_API_BASE_URL, overrides)));
  }

  async getStatus(shipmentId: string): Promise<{ data: ShipmentStatus; meta: CallMeta }> {
    const res = await this.http.request({
      method: 'GET',
      path: `/v1/shipments/${encodeURIComponent(shipmentId)}`,
      schema: BackendShipmentSchema,
      retryable: true,
    });
    const s = res.data;
    return {
      data: {
        shipment_id: s.shipmentId,
        status: s.status,
        carrier: s.carrier,
        origin: s.origin,
        destination: s.destination,
        estimated_delivery: s.estimatedDelivery,
        last_updated: s.lastUpdated,
      },
      meta: { attempts: res.attempts },
    };
  }

  async getTrackingHistory(shipmentId: string): Promise<{ data: { shipment_id: string; events: TrackingEvent[] }; meta: CallMeta }> {
    const res = await this.http.request({
      method: 'GET',
      path: `/v1/shipments/${encodeURIComponent(shipmentId)}/events`,
      schema: BackendTrackingSchema,
      retryable: true,
    });
    const events = [...res.data.events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { data: { shipment_id: res.data.shipmentId, events }, meta: { attempts: res.attempts } };
  }
}

export interface CreateTicketInput {
  shipment_id: string;
  category: (typeof TicketCategoryValues)[number];
  description: string;
  idempotency_key: string;
}

export class SupportAdapter {
  constructor(private readonly http: BackendHttpClient) {}

  static fromEnv(env: BackendEnv, overrides?: Partial<HttpClientOptions>): SupportAdapter {
    return new SupportAdapter(new BackendHttpClient(clientOptions(env, env.SUPPORT_API_BASE_URL, overrides)));
  }

  async getDeliveryExceptions(shipmentId: string): Promise<{ data: { shipment_id: string; exceptions: DeliveryException[] }; meta: CallMeta }> {
    const res = await this.http.request({
      method: 'GET',
      path: `/v1/shipments/${encodeURIComponent(shipmentId)}/exceptions`,
      schema: BackendExceptionsSchema,
      retryable: true,
    });
    return {
      data: {
        shipment_id: res.data.shipmentId,
        exceptions: res.data.exceptions.map((e) => ({
          exception_id: e.exceptionId,
          type: e.type,
          description: e.description,
          occurred_at: e.occurredAt,
          resolution_status: e.resolutionStatus,
        })),
      },
      meta: { attempts: res.attempts },
    };
  }

  /**
   * Creates a ticket. The same idempotency key is sent on every retry attempt, so a request
   * that committed on the backend but whose response was lost is replayed, not duplicated.
   */
  async createTicket(input: CreateTicketInput): Promise<{ data: SupportTicket; meta: CallMeta }> {
    const res = await this.http.request({
      method: 'POST',
      path: '/v1/tickets',
      headers: { 'idempotency-key': input.idempotency_key },
      body: { shipmentId: input.shipment_id, category: input.category, description: input.description },
      schema: BackendTicketSchema,
      retryable: true,
    });
    const t = res.data;
    return {
      data: {
        ticket_id: t.ticketId,
        shipment_id: t.shipmentId,
        status: t.status,
        category: t.category,
        created_at: t.createdAt,
        replayed: res.status === 200,
      },
      meta: { attempts: res.attempts },
    };
  }
}

/**
 * Derives a stable idempotency key from the ticket's semantic content. If the model re-issues
 * the same ticket request (e.g. after a transport error) without supplying a key, it maps to
 * the same backend ticket instead of creating a duplicate.
 */
export function deriveIdempotencyKey(shipmentId: string, category: string, description: string): string {
  const normalized = `${shipmentId.toUpperCase()}|${category}|${description.trim().toLowerCase().replace(/\s+/g, ' ')}`;
  return 'derived-' + createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}
