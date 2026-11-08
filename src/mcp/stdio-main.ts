import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Logger } from '../shared/logger.js';

/**
 * Runs `start` only when `moduleUrl` is the process entry point, so server modules can be
 * imported by tests without spawning a stdio listener. Installs shutdown handlers that close
 * the server when the parent closes stdin or sends a signal.
 */
export async function runStdioServer(moduleUrl: string, log: Logger, start: () => Promise<McpServer>): Promise<void> {
  const entry = process.argv[1];
  if (!entry) return;
  let isMain = false;
  try {
    isMain = realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    isMain = false;
  }
  if (!isMain) return;

  try {
    const server = await start();
    log.info('server ready on stdio', { pid: process.pid });
    let closing = false;
    const shutdown = async (reason: string) => {
      if (closing) return;
      closing = true;
      log.info('shutting down', { reason });
      try {
        await server.close();
      } finally {
        process.exit(0);
      }
    };
    process.stdin.on('end', () => void shutdown('stdin closed'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (err) {
    log.error('failed to start', { error: String((err as Error)?.stack ?? err) });
    process.exit(1);
  }
}
