import type { JSONRPCMessage, MessageExtraInfo, Transport, TransportSendOptions } from '@modelcontextprotocol/client';

/**
 * One MCP `tools/call` exchange observed on the wire (JSON-RPC request and its response).
 * Recorded from the actual transport, so it reflects what the MCP server really received
 * and returned — never inferred from the model's final answer.
 */
export interface McpCallRecord {
  server: string;
  requestId: string | number;
  tool: string;
  arguments: unknown;
  startedAt: string;
  durationMs: number | null;
  /** The MCP `CallToolResult` (when the server answered with a result). */
  result: unknown;
  /** `result.isError` from the MCP result. */
  isError: boolean | null;
  /** JSON-RPC protocol-level error, if any. */
  rpcError: unknown;
  /** Correlation tags (eval run / case / turn) captured when the call was sent. */
  tags: Record<string, string>;
}

/** Shared sink that collects calls from all recording transports. */
export class McpTraceRecorder {
  readonly calls: McpCallRecord[] = [];
  /** Mutable tags applied to calls at send time (e.g. runId, caseId, turn). */
  tags: Record<string, string> = {};

  clear(): void {
    this.calls.length = 0;
  }
}

type AnyMessage = { id?: string | number; method?: string; params?: { name?: string; arguments?: unknown }; result?: unknown; error?: unknown };

/** Transport decorator that records `tools/call` traffic while passing every frame through unchanged. */
export class RecordingTransport implements Transport {
  private _onmessage: Transport['onmessage'];
  private readonly pending = new Map<string | number, { record: McpCallRecord; t0: number }>();

  constructor(
    private readonly inner: Transport,
    private readonly server: string,
    private readonly recorder: McpTraceRecorder,
  ) {
    inner.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
      this.observeIncoming(message as unknown as AnyMessage);
      this._onmessage?.(message, extra);
    };
    inner.onclose = () => this.onclose?.();
    inner.onerror = (e: Error) => this.onerror?.(e);
  }

  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;

  get onmessage(): Transport['onmessage'] {
    return this._onmessage;
  }
  set onmessage(fn: Transport['onmessage']) {
    this._onmessage = fn;
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion = (version: string): void => {
    this.inner.setProtocolVersion?.(version);
  };

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const m = message as unknown as AnyMessage;
    if (m.method === 'tools/call' && m.id !== undefined) {
      const record: McpCallRecord = {
        server: this.server,
        requestId: m.id,
        tool: String(m.params?.name ?? ''),
        arguments: structuredClone(m.params?.arguments ?? {}),
        startedAt: new Date().toISOString(),
        durationMs: null,
        result: null,
        isError: null,
        rpcError: null,
        tags: { ...this.recorder.tags },
      };
      this.recorder.calls.push(record);
      this.pending.set(m.id, { record, t0: performance.now() });
    }
    return this.inner.send(message, options);
  }

  private observeIncoming(m: AnyMessage): void {
    if (m.id === undefined || m.method !== undefined) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    p.record.durationMs = Math.round(performance.now() - p.t0);
    if (m.error !== undefined) {
      p.record.rpcError = m.error;
    } else {
      p.record.result = m.result;
      p.record.isError = Boolean((m.result as { isError?: boolean } | undefined)?.isError);
    }
  }
}
