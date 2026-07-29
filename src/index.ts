import { Registry } from 'prom-client';
import { createApp } from './app';
import { scheduleCleanup } from './cleanup';
import { ConfigError, loadConfig } from './config';
import { createDb } from './db';
import { createLogger } from './logger';
import { createMetrics } from './metrics';
import { createSesClient } from './ses-client';
import { createShutdownHandler } from './shutdown';
import { SqsPoller } from './sqs-poller';
import { attachDbGauges, createStats } from './stats';
import type { Config } from './types';

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    createLogger({ logLevel: 'info' })
      .child({ component: 'config' })
      .fatal({ err }, err.message);
    return process.exit(1);
  }
}

const config = loadConfigOrExit();
const logger = createLogger(config);

const metrics = createMetrics(new Registry());
const db = createDb(config.dbPath, logger, metrics);
const stats = createStats(db);
attachDbGauges(metrics, stats, db);
const ses = createSesClient(config, { logger, metrics });

const deps = { config, logger, metrics, db, ses, stats };

const server = createApp(deps).listen(config.port, () => {
  logger.child({ component: 'lifecycle' }).info(
    {
      port: config.port,
      domain: config.mailgunDomain,
      region: config.awsRegion,
      configurationSet: config.sesConfigurationSet,
      sendConcurrency: config.sendConcurrency,
    },
    'ghost-ses-proxy listening',
  );
});

const poller = new SqsPoller(deps);
poller.start();

// D6 is pinned as-is: no cleanup runs at startup.
const cleanupTimer = scheduleCleanup(db, logger, metrics);

const shutdown = createShutdownHandler({
  server,
  poller,
  cleanupTimer,
  db,
  logger,
});

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
