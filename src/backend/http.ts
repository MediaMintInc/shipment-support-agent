import { setTimeout as sleep } from 'node:timers/promises';
import type { z } from 'zod';
import { BackendError, BackendErrorCode } from './errors.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('backend-http');

export interface HttpClientOptions {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  /** When non-empty, requests to any other origin fail before leaving the process. */
  allowedOrigins?: string[];
  apiToken?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<unknown>;
}

export interface RequestOptions<T> {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  schema: z.ZodType<T>;
  /**
   * Whether the request may be retried. GETs are safe; POSTs are only retried when the
   * caller supplies an idempotency key so a replay cannot create a duplicate side effect.
   */
  retryable: boolean;
}

export interface HttpResult<T> {
  data: T;
  status: number;
  attempts: number;
}

/**
 * JSON-over-HTTP client with per-attempt timeout, bounded exponential-backoff retries,
 * response schema validation, and an optional destination allow-list.
 */
export class BackendHttpClient {
  private readonly opts: Required<Omit<HttpClientOptions, 'apiToken' | 'allowedOrigins'>> &
    Pick<HttpClientOptions, 'apiToken' | 'allowedOrigins'>;

  constructor(opts: HttpClientOptions) {
    this.opts = {
      fetchImpl: globalThis.fetch.bind(globalThis),
      sleepImpl: (ms: number) => sleep(ms),
      ...opts,
      baseUrl: opts.baseUrl.replace(/\/+$/, ''),
    };
  }

  get maxAttempts(): number {
    return this.opts.maxRetries + 1;
  }

  async request<T>(req: RequestOptions<T>): Promise<HttpResult<T>> {
    const url = new URL(this.opts.baseUrl + req.path);
    this.assertAllowed(url);
    const attemptsAllowed = req.retryable ? this.maxAttempts : 1;

    let lastError: BackendError | undefined;
    for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
      try {
        const result = await this.once(url, req);
        return { ...result, attempts: attempt };
      } catch (err) {
        const be = err instanceof BackendError ? err : new BackendError(BackendErrorCode.NETWORK_ERROR, String(err), { retryable: true, cause: err });
        lastError = be.withAttempts(attempt);
        const willRetry = be.retryable && attempt < attemptsAllowed;
        log.warn('backend request failed', {
          method: req.method,
          url: url.toString(),
          attempt,
          code: be.code,
          status: be.status,
          willRetry,
        });
        if (!willRetry) break;
        await this.opts.sleepImpl(this.backoff(attempt, be));
      }
    }
    throw lastError ?? new BackendError(BackendErrorCode.NETWORK_ERROR, 'request failed');
  }

  private backoff(attempt: number, err: BackendError & { retryAfterMs?: number }): number {
    const exp = this.opts.retryBaseDelayMs * 2 ** (attempt - 1);
    const hinted = err.retryAfterMs ?? 0;
    return Math.min(Math.max(exp, hinted), this.opts.retryMaxDelayMs);
  }

  private assertAllowed(url: URL): void {
    const allowed = this.opts.allowedOrigins;
    if (!allowed || allowed.length === 0) return;
    if (!allowed.includes(url.origin)) {
      throw new BackendError(
        BackendErrorCode.DESTINATION_NOT_ALLOWED,
        `Destination ${url.origin} is not in BACKEND_ALLOWED_ORIGINS`,
      );
    }
  }

  private async once<T>(url: URL, req: RequestOptions<T>): Promise<{ data: T; status: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await this.opts.fetchImpl(url, {
        method: req.method,
        headers: {
          accept: 'application/json',
          ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.opts.apiToken ? { authorization: `Bearer ${this.opts.apiToken}` } : {}),
          ...req.headers,
        },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        // Never follow redirects: a 3xx to another host would bypass the destination allow-list.
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new BackendError(BackendErrorCode.TIMEOUT, `Backend did not respond within ${this.opts.timeoutMs} ms`, { retryable: true, cause: err });
      }
      throw new BackendError(BackendErrorCode.NETWORK_ERROR, `Backend unreachable: ${(err as Error).message}`, { retryable: true, cause: err });
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new BackendError(BackendErrorCode.TIMEOUT, `Backend response not completed within ${this.opts.timeoutMs} ms`, { retryable: true, cause: err });
      }
      throw new BackendError(BackendErrorCode.NETWORK_ERROR, 'Failed reading backend response', { retryable: true, cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw this.statusError(res, text);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BackendError(BackendErrorCode.MALFORMED_RESPONSE, 'Backend returned a non-JSON body', { status: res.status });
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) {
      throw new BackendError(
        BackendErrorCode.MALFORMED_RESPONSE,
        `Backend response failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
        { status: res.status },
      );
    }
    return { data: parsed.data, status: res.status };
  }

  private statusError(res: Response, body: string): BackendError {
    const status = res.status;
    if ((status >= 300 && status < 400) || res.type === 'opaqueredirect') {
      return new BackendError(BackendErrorCode.DESTINATION_NOT_ALLOWED, `Backend responded with a redirect (HTTP ${status}); redirects are not followed`, { status });
    }
    if (status === 404) return new BackendError(BackendErrorCode.NOT_FOUND, 'Resource not found', { status });
    if (status === 409) return new BackendError(BackendErrorCode.CONFLICT, 'Conflicting request', { status });
    if (status === 429) {
      const err = new BackendError(BackendErrorCode.RATE_LIMITED, 'Backend rate limit exceeded', { status, retryable: true }) as BackendError & { retryAfterMs?: number };
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra >= 0) err.retryAfterMs = ra * 1000;
      return err;
    }
    if (status >= 500) return new BackendError(BackendErrorCode.UPSTREAM_ERROR, `Backend server error (HTTP ${status})`, { status, retryable: true });
    return new BackendError(BackendErrorCode.BAD_REQUEST, `Backend rejected request (HTTP ${status}): ${body.slice(0, 200)}`, { status });
  }
}

export function parseAllowedOrigins(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => new URL(s).origin);
  return list.length ? list : undefined;
}
