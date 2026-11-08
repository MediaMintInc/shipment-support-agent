/**
 * Restricts outbound `fetch` from the eval harness process to loopback (mock service) plus the
 * explicitly allowed LLM provider hosts. Backend traffic from the MCP server processes is
 * restricted separately by BACKEND_ALLOWED_ORIGINS in the backend adapters.
 *
 * Note: the AWS SDK (Bedrock) uses Node's http module rather than fetch, so for Bedrock the
 * provider is allowed implicitly; the backend restriction is unaffected.
 */
export interface NetGuard {
  blocked: string[];
  uninstall(): void;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function installNetGuard(allowedHosts: string[]): NetGuard {
  const original = globalThis.fetch;
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const blocked: string[] = [];
  const guarded: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const host = url.hostname.toLowerCase();
    if (!LOOPBACK.has(host) && !allowed.has(host)) {
      blocked.push(url.origin);
      return Promise.reject(new Error(`Network guard: outbound request to ${url.origin} is not allowed in evaluation mode`));
    }
    return original(input, init);
  };
  globalThis.fetch = guarded;
  return {
    blocked,
    uninstall() {
      globalThis.fetch = original;
    },
  };
}

/** Throws unless every URL points at a loopback host. */
export function assertLoopback(urls: Record<string, string>): void {
  for (const [name, u] of Object.entries(urls)) {
    const host = new URL(u).hostname;
    if (!LOOPBACK.has(host)) throw new Error(`${name}=${u} must point at the local mock service in evaluation mode`);
  }
}
