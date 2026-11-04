import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDb, disconnectDb } from './lib/db.js';
import { logger } from './lib/logger.js';
import { scheduleMaintenance } from './jobs/maintenance.js';
import { ensureAdminAccount } from './services/admin.service.js';
import { activityService } from './services/activity.service.js';
import { s3StatsService } from './services/s3Stats.service.js';

async function main() {
  await connectDb();
  await ensureAdminAccount();
  const app = createApp();
  const server = app.listen(env.PORT, (err) => {
    // Express reports a failure to bind (such as a port in use) through this callback.
    if (err) throw err;
    logger.info(`API listening on :${env.PORT}`);
  });
  const stopJobs = scheduleMaintenance();
  const stopActivity = activityService.startFlusher();
  const stopStats = s3StatsService.startScheduler();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopJobs();
    stopActivity();
    stopStats();
    server.close(() => {
      activityService
        .flush()
        .catch(() => undefined) // Whatever could not be written stays in the outbox for next time.
        .then(() => disconnectDb())
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: err.message }, 'Failed to start');
  process.exit(1);
});
