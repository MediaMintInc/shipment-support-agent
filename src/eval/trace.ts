import type { McpCallRecord } from '../agent/recording-transport.js';
import type { AgentToolEvent } from '../agent/agent.js';
import type { RecordedRequest, TicketRecord } from '../mock/server.js';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TurnTrace {
  index: number;
  user: string;
  response: string;
  latencyMs: number;
  mcpCalls: McpCallRecord[];
  agentToolEvents: AgentToolEvent[];
  usage: TokenUsage | null;
}

/** Everything observed while running one case once. Collected from the wire, hooks and the mock. */
export interface CaseTrace {
  runId: string;
  caseId: string;
  iteration: number;
  turns: TurnTrace[];
  mcpCalls: McpCallRecord[];
  agentToolEvents: AgentToolEvent[];
  backendRequests: RecordedRequest[];
  tickets: TicketRecord[];
  error: string | null;
  timedOut: boolean;
  latencyMs: number;
  usage: TokenUsage | null;
}

/** Parses the JSON payload of an MCP CallToolResult (structuredContent preferred). */
export function toolPayload(call: McpCallRecord): Record<string, unknown> | null {
  const r = call.result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> } | null;
  if (!r) return null;
  if (r.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent as Record<string, unknown>;
  const text = r.content?.find((c) => c.type === 'text')?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return { _text: text };
  }
}

export function toolSucceeded(call: McpCallRecord): boolean {
  return call.rpcError == null && call.isError === false;
}

export function toolErrorCode(call: McpCallRecord): string | null {
  if (call.rpcError) return 'RPC_ERROR';
  if (!call.isError) return null;
  const p = toolPayload(call);
  const err = p?.error as { code?: string } | undefined;
  if (err?.code) return err.code;
  const text = (p?._text as string | undefined) ?? '';
  if (/Input validation error/i.test(text)) return 'INVALID_ARGUMENTS';
  return 'TOOL_ERROR';
}

export function toolResultText(call: McpCallRecord): string {
  const r = call.result as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown } | null;
  const parts: string[] = [];
  if (r?.content) for (const c of r.content) if (c.text) parts.push(c.text);
  if (r?.structuredContent) parts.push(JSON.stringify(r.structuredContent));
  if (call.rpcError) parts.push(JSON.stringify(call.rpcError));
  return parts.join('\n');
}
