/**
 * Structured logger that writes exclusively to stderr.
 *
 * MCP stdio servers use stdout for JSON-RPC frames; anything else written to stdout
 * corrupts the protocol. Every component in this project logs through this module.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
  return ORDER[raw] ?? ORDER.info;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(component: string): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < threshold()) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, component, msg, ...fields });
    process.stderr.write(line + '\n');
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
