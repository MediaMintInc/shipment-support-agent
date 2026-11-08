import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadDotEnv, readAgentEnv } from '../config/env.js';
import { assertCredentials, createModel } from './model.js';
import { createShipmentAgent, finalText } from './agent.js';

/**
 * Interactive local agent. Usage:
 *   npm run agent                       # interactive REPL
 *   npm run agent -- "Where is SHP-100001?"   # single message
 * Backend URLs come from SHIPMENT_API_BASE_URL / SUPPORT_API_BASE_URL (default: local mock on :4010).
 */
loadDotEnv();
const env = readAgentEnv();
try {
  assertCredentials(env);
} catch (err) {
  process.stderr.write(`[agent] configuration error: ${(err as Error).message} See .env.example.\n`);
  process.exit(2);
}
const { model, info } = await createModel(env);
const handle = createShipmentAgent({ model, env, printer: false });
process.stderr.write(`[agent] provider=${info.provider} model=${info.modelId}\n`);

let exitCode = 0;
try {
  const oneShot = process.argv.slice(2).join(' ').trim();
  if (oneShot) {
    const result = await handle.agent.invoke(oneShot);
    stdout.write(finalText(result) + '\n');
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    stdout.write('Shipment support agent. Type "exit" to quit.\n');
    for (;;) {
      const line = (await rl.question('you> ')).trim();
      if (!line) continue;
      if (line === 'exit' || line === 'quit') break;
      try {
        const result = await handle.agent.invoke(line);
        stdout.write(`agent> ${finalText(result)}\n`);
      } catch (err) {
        stdout.write(`agent error: ${(err as Error).message}\n`);
      }
    }
    rl.close();
  }
} catch (err) {
  process.stderr.write(`[agent] failed: ${(err as Error).message}\n`);
  exitCode = 1;
} finally {
  await handle.close();
}
process.exit(exitCode);
