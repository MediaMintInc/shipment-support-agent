import path from 'node:path';
import type { Writable } from 'node:stream';
import { McpClient } from '@strands-agents/sdk';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { PROJECT_ROOT, splitArgs, type AgentEnv } from '../config/env.js';
import { McpTraceRecorder, RecordingTransport } from './recording-transport.js';

export interface McpConnectionOptions {
  /** Extra environment for the MCP server processes (e.g. backend URLs pointing at the mock). */
  serverEnv?: Record<string, string>;
  /** Where server stderr goes. Defaults to inheriting the parent's stderr. */
  stderr?: 'inherit' | Writable;
  /** Records every tools/call request/response on the wire. */
  recorder?: McpTraceRecorder;
}

export interface McpConnections {
  clients: McpClient[];
  recorder: McpTraceRecorder;
  /** Disconnects both clients, which terminates the child server processes. */
  close(): Promise<void>;
}

/** Variables forwarded to server processes in addition to the MCP SDK's safe defaults. */
const FORWARDED_ENV = [
  'SHIPMENT_API_BASE_URL',
  'SUPPORT_API_BASE_URL',
  'BACKEND_API_TOKEN',
  'BACKEND_TIMEOUT_MS',
  'BACKEND_MAX_RETRIES',
  'BACKEND_RETRY_BASE_DELAY_MS',
  'BACKEND_RETRY_MAX_DELAY_MS',
  'BACKEND_ALLOWED_ORIGINS',
  'LOG_LEVEL',
];

function serverEnvironment(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const key of FORWARDED_ENV) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return { ...env, ...extra };
}

function makeTransport(
  name: string,
  command: string,
  rawArgs: string,
  opts: McpConnectionOptions,
  recorder: McpTraceRecorder,
): RecordingTransport {
  const args = splitArgs(rawArgs).map((a) => (a.endsWith('.js') && !path.isAbsolute(a) ? path.join(PROJECT_ROOT, a) : a));
  const pipeStderr = opts.stderr !== undefined && opts.stderr !== 'inherit';
  const inner = new StdioClientTransport({
    command,
    args,
    cwd: PROJECT_ROOT,
    env: serverEnvironment(opts.serverEnv),
    stderr: pipeStderr ? 'pipe' : 'inherit',
  });
  if (pipeStderr) {
    const sink = opts.stderr as Writable;
    // `stderr` is available immediately when piped (a PassThrough is created before spawn).
    inner.stderr?.on('data', (chunk: Buffer) => sink.write(chunk));
  }
  return new RecordingTransport(inner, name, recorder);
}

/**
 * Creates Strands MCP clients for the shipment and support servers. Each server runs as a
 * child process speaking MCP over stdio; the agent sees their tools exactly as advertised.
 */
export function createMcpConnections(env: AgentEnv, opts: McpConnectionOptions = {}): McpConnections {
  const recorder = opts.recorder ?? new McpTraceRecorder();
  const shipment = new McpClient({
    applicationName: 'shipment-support-agent',
    transport: makeTransport('shipment', env.SHIPMENT_MCP_COMMAND, env.SHIPMENT_MCP_ARGS, opts, recorder),
  });
  const support = new McpClient({
    applicationName: 'shipment-support-agent',
    transport: makeTransport('support', env.SUPPORT_MCP_COMMAND, env.SUPPORT_MCP_ARGS, opts, recorder),
  });
  const clients = [shipment, support];
  return {
    clients,
    recorder,
    async close() {
      await Promise.allSettled(clients.map((c) => c.disconnect()));
    },
  };
}
