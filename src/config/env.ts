import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Project root (one level above `src/` or `dist/`). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Minimal `.env` loader (no dependency). Existing process env always wins, so CI and
 * the eval harness can override anything in the file.
 */
export function loadDotEnv(file = path.join(PROJECT_ROOT, '.env')): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const intFromEnv = (def: number, min = 0) =>
  z.coerce.number().int().min(min).default(def);

/** Settings read by the MCP servers' backend adapters. */
export const BackendEnvSchema = z.object({
  SHIPMENT_API_BASE_URL: z.url().default('http://127.0.0.1:4010/shipment-api'),
  SUPPORT_API_BASE_URL: z.url().default('http://127.0.0.1:4010/support-api'),
  BACKEND_API_TOKEN: z.string().optional(),
  BACKEND_TIMEOUT_MS: intFromEnv(5000, 1),
  BACKEND_MAX_RETRIES: intFromEnv(2, 0),
  BACKEND_RETRY_BASE_DELAY_MS: intFromEnv(200, 0),
  BACKEND_RETRY_MAX_DELAY_MS: intFromEnv(2000, 0),
  /** Comma-separated origins. When set, the adapters refuse any other destination. */
  BACKEND_ALLOWED_ORIGINS: z.string().optional(),
});
export type BackendEnv = z.infer<typeof BackendEnvSchema>;

export function readBackendEnv(env: NodeJS.ProcessEnv = process.env): BackendEnv {
  return BackendEnvSchema.parse(env);
}

/** Settings for the agent process (model + MCP connections). */
export const AgentEnvSchema = z.object({
  MODEL_PROVIDER: z.enum(['openai', 'anthropic', 'bedrock']).default('openai'),
  MODEL_ID: z.string().min(1).optional(),
  /**
   * Only sent when set. Leave unset for OpenAI reasoning models (GPT-5 family), which
   * reject non-default temperatures.
   */
  MODEL_TEMPERATURE: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().min(0).max(2).optional()),
  MODEL_MAX_TOKENS: intFromEnv(4096, 1),
  AWS_REGION: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  /** `responses` (SDK default, stateless here) or `chat` (Chat Completions). */
  OPENAI_API_MODE: z.enum(['responses', 'chat']).default('responses'),
  /** Optional OpenAI-compatible endpoint (proxy / gateway). */
  OPENAI_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
  OPENAI_ORG_ID: z.string().optional(),
  /** Reasoning effort for reasoning models, e.g. none | minimal | low | medium | high. */
  OPENAI_REASONING_EFFORT: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Optional per-million-token prices used to estimate cost in eval reports. */
  MODEL_INPUT_COST_PER_MTOK: z.coerce.number().nonnegative().optional(),
  MODEL_OUTPUT_COST_PER_MTOK: z.coerce.number().nonnegative().optional(),

  SHIPMENT_MCP_COMMAND: z.string().default(process.execPath),
  SHIPMENT_MCP_ARGS: z.string().default('dist/mcp/shipment-server.js'),
  SUPPORT_MCP_COMMAND: z.string().default(process.execPath),
  SUPPORT_MCP_ARGS: z.string().default('dist/mcp/support-server.js'),
  /** Hard cap on tool calls per agent invocation (defence against loops). */
  AGENT_MAX_TOOL_CALLS: intFromEnv(8, 1),
});
export type AgentEnv = z.infer<typeof AgentEnvSchema>;

export function readAgentEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv {
  return AgentEnvSchema.parse(env);
}

/** Splits a space-separated args string, honouring simple double quotes. */
export function splitArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out.push(m[1] ?? m[2] ?? '');
  return out;
}
