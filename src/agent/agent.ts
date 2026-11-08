import { Agent, BeforeInvocationEvent, BeforeToolCallEvent, AfterToolCallEvent, type Model } from '@strands-agents/sdk';
import type { AgentEnv } from '../config/env.js';
import { SHIPMENT_AGENT_SYSTEM_PROMPT } from './prompt.js';
import { createMcpConnections, type McpConnectionOptions, type McpConnections } from './mcp-clients.js';

/** Agent-side view of a tool call (from Strands hooks); complements the wire-level MCP trace. */
export interface AgentToolEvent {
  toolUseId: string;
  name: string;
  input: unknown;
  status: 'success' | 'error' | 'cancelled' | null;
  cancelledReason?: string;
}

export interface ShipmentAgentHandle {
  agent: Agent;
  mcp: McpConnections;
  toolEvents: AgentToolEvent[];
  close(): Promise<void>;
}

export interface CreateAgentOptions extends McpConnectionOptions {
  model: Model;
  env: AgentEnv;
  /** Log streaming output to stdout (CLI); off for evals and tests. */
  printer?: boolean;
}

/**
 * Builds the shipment support agent. The same function is used by the CLI, the offline
 * orchestration tests (with a scripted model) and the real-LLM evaluations.
 */
export function createShipmentAgent(opts: CreateAgentOptions): ShipmentAgentHandle {
  const mcp = createMcpConnections(opts.env, opts);
  const agent = new Agent({
    model: opts.model,
    systemPrompt: SHIPMENT_AGENT_SYSTEM_PROMPT,
    tools: mcp.clients,
    printer: opts.printer ?? false,
  });

  const toolEvents: AgentToolEvent[] = [];
  const maxCalls = opts.env.AGENT_MAX_TOOL_CALLS;
  let callsThisInvocation = 0;

  agent.addHook(BeforeInvocationEvent, () => {
    callsThisInvocation = 0;
  });
  agent.addHook(BeforeToolCallEvent, (event) => {
    callsThisInvocation++;
    const rec: AgentToolEvent = { toolUseId: event.toolUse.toolUseId, name: event.toolUse.name, input: event.toolUse.input, status: null };
    if (callsThisInvocation > maxCalls) {
      const reason = `Tool call limit of ${maxCalls} per request reached; stop calling tools and answer with what you have.`;
      event.cancel = reason;
      rec.status = 'cancelled';
      rec.cancelledReason = reason;
    }
    toolEvents.push(rec);
  });
  agent.addHook(AfterToolCallEvent, (event) => {
    const rec = toolEvents.find((t) => t.toolUseId === event.toolUse.toolUseId);
    if (rec && rec.status === null) rec.status = event.result.status === 'error' ? 'error' : 'success';
  });

  return {
    agent,
    mcp,
    toolEvents,
    async close() {
      await mcp.close();
    },
  };
}

/** Extracts the plain text of the agent's final message. */
export function finalText(result: { lastMessage: { content: ReadonlyArray<unknown> } }): string {
  return result.lastMessage.content
    .map((b) => (b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}
