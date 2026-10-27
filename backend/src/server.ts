import { startApi } from './api.js';
import { apiConfig } from './config/api.js';
import { loadConfig } from './config/load.js';
import { onShutdownSignals } from './http/shutdown.js';
import { createLogger } from './observability/logger.js';

async function main() {
  const config = loadConfig(apiConfig.schema);
  if (!config) return;
  const logger = createLogger(config.LOG_LEVEL);
  const api = await startApi(config, logger);
  onShutdownSignals(api.close, { logger });
}

main().catch((error: unknown) => {
  createLogger().fatal({ err: error }, 'api failed to start');
  process.exit(1);
});
