import path from 'node:path';
import { loadFixtureFile } from './fixtures.js';
import { MockBackend } from './server.js';
import { PROJECT_ROOT } from '../config/env.js';
import { createLogger } from '../shared/logger.js';

/** Standalone mock backend for local runs: `npm run mock` then `npm run agent` in another shell. */
const log = createLogger('mock-main');
const port = Number(process.env.MOCK_PORT ?? 4010);
const fixtureFile = process.env.MOCK_FIXTURES ?? path.join(PROJECT_ROOT, 'fixtures', 'base.yaml');

const mock = new MockBackend();
const url = await mock.start(port);
mock.loadFixtures(loadFixtureFile(fixtureFile));
log.info('mock backend ready', {
  shipmentApi: `${url}/shipment-api`,
  supportApi: `${url}/support-api`,
  fixtures: fixtureFile,
});
const stop = async () => {
  await mock.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
