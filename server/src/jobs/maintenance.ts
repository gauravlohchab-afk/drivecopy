import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { withLock } from '../lib/lock.js';
import { uploadMaintenance } from '../services/upload.service.js';
import { purgeService } from '../services/trash.service.js';

export async function runMaintenance() {
  // One instance at a time across a fleet.
  return withLock(
    'job:maintenance',
    async () => {
      const uploads = await uploadMaintenance.run();
      const purge = await purgeService.run();
      logger.info({ uploads, purge }, 'Maintenance run finished');
      return { uploads, purge };
    },
    { ttlMs: 10 * 60_000, waitMs: 0 },
  );
}

export function scheduleMaintenance() {
  if (!env.CLEANUP_INTERVAL_MINUTES) return () => undefined;
  const timer = setInterval(() => {
    runMaintenance().catch((err) => logger.warn({ code: err?.code, msg: err?.message }, 'Maintenance run skipped'));
  }, env.CLEANUP_INTERVAL_MINUTES * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
