import { env } from '../config/env.js';
import { Lock, StorageStats } from '../models/index.js';
import { logger } from '../lib/logger.js';
import { withLock } from '../lib/lock.js';
import { s3Service } from './s3.service.js';

const ID = 's3';
// Everything users store is under this prefix, shared drives included. Activity logs are not files.
const FILES_PREFIX = 'users/';
// Short, and renewed while a listing runs, so a crashed process blocks listings only briefly.
const SCAN_LOCK_TTL_MS = 2 * 60_000;
const SCAN_LOCK_RENEW_MS = 30_000;
const SCAN_LOCK = 'job:s3-stats';
const RETRY_FAILED_SCAN_MS = 60_000;
// After a change, a listing confirms the figures. Bursts of changes share one.
const RESCAN_DELAY_MS = 5 * 60_000;
const FIRST_SCAN_WAIT_MS = 8_000;

export function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

let inFlight: Promise<void> | null = null;
let schedulerRunning = false;
let rescanTimer: NodeJS.Timeout | null = null;

function scheduleRescan() {
  if (!schedulerRunning || rescanTimer) return;
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    void s3StatsService.refresh();
  }, RESCAN_DELAY_MS);
  rescanTimer.unref();
}

/** Lists every object (the service follows S3's pagination) and stores the totals. */
async function scan() {
  const before = await StorageStats.findById(ID, { revision: 1 }).lean();
  const revision = before?.revision ?? 0;
  let totalBytes = 0;
  let totalFiles = 0;
  let renewedAt = Date.now();
  for await (const obj of s3Service.listObjects(FILES_PREFIX)) {
    totalBytes += obj.size;
    totalFiles++;
    if (Date.now() - renewedAt > SCAN_LOCK_RENEW_MS) {
      renewedAt = Date.now();
      await Lock.updateOne({ _id: SCAN_LOCK }, { $set: { expiresAt: new Date(renewedAt + SCAN_LOCK_TTL_MS) } });
    }
  }
  const now = new Date();
  try {
    // Only applies if nothing changed during the listing, since the result could miss that change.
    await StorageStats.updateOne(
      { _id: ID, revision },
      { $set: { totalBytes, totalFiles, lastVerifiedAt: now, lastUpdatedAt: now, lastErrorAt: null } },
      { upsert: true },
    );
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    // The incrementally updated figures stay in place; verify them again once things settle.
    await StorageStats.updateOne({ _id: ID }, { $set: { lastErrorAt: null } });
    scheduleRescan();
  }
}

export const s3StatsService = {
  /** Recomputes from S3. Never throws: on failure the last verified figures are kept. */
  refresh(): Promise<void> {
    inFlight ??= withLock(SCAN_LOCK, scan, { ttlMs: SCAN_LOCK_TTL_MS, waitMs: 0 })
      .catch(async (err) => {
        if ((err as { code?: string }).code === 'BUSY') {
          // Another instance is on it, or a crashed one left its lock: look again later.
          scheduleRescan();
          return;
        }
        logger.warn({ code: (err as { s3Error?: string }).s3Error }, 'Could not refresh S3 usage');
        await StorageStats.updateOne({ _id: ID }, { $set: { lastErrorAt: new Date() } }, { upsert: true }).catch(() => undefined);
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  },

  /**
   * Keeps the figures current after an upload or delete, without listing the bucket. A browser's
   * upload reaches S3 before the app hears it finished, so a listing in that gap has already counted
   * the file and this counts it again. The listing scheduled here corrects that.
   */
  async adjust(bytes: number, files: number) {
    scheduleRescan();
    try {
      await StorageStats.updateOne(
        { _id: ID, lastVerifiedAt: { $ne: null } },
        { $inc: { totalBytes: bytes, totalFiles: files, revision: 1 }, $set: { lastUpdatedAt: new Date() } },
      );
    } catch (err) {
      // The next full listing corrects the figures, so this must not fail the file operation.
      logger.warn({ err: (err as Error).message }, 'Could not update S3 usage');
    }
  },

  /** Returns cached figures. Never invents a number: they are null until a listing has succeeded. */
  async read() {
    let stats = await StorageStats.findById(ID).lean();
    if (!stats?.lastVerifiedAt) {
      // First use: give the listing a moment, then answer anyway and let it finish in the background.
      await Promise.race([this.refresh(), new Promise((r) => setTimeout(r, FIRST_SCAN_WAIT_MS).unref())]);
      stats = await StorageStats.findById(ID).lean();
    } else if (
      env.STORAGE_STATS_REFRESH_MINUTES &&
      Date.now() - stats.lastVerifiedAt.getTime() > env.STORAGE_STATS_REFRESH_MINUTES * 60_000
    ) {
      void this.refresh();
    }
    // A failed listing is retried when someone looks, so the status recovers by itself.
    if (stats?.lastErrorAt && Date.now() - stats.lastErrorAt.getTime() > RETRY_FAILED_SCAN_MS) void this.refresh();
    const known = Boolean(stats?.lastVerifiedAt);
    const failing = Boolean(stats?.lastErrorAt);
    return {
      storageType: 'Amazon S3',
      status: failing ? ('unavailable' as const) : known ? ('connected' as const) : ('checking' as const),
      totalBytes: known ? Math.max(0, stats!.totalBytes) : null,
      totalFiles: known ? Math.max(0, stats!.totalFiles) : null,
      totalSize: known ? humanSize(stats!.totalBytes) : null,
      lastVerifiedAt: stats?.lastVerifiedAt?.toISOString() ?? null,
      lastUpdatedAt: stats?.lastUpdatedAt?.toISOString() ?? null,
    };
  },

  startScheduler() {
    schedulerRunning = true;
    void this.refresh();
    const timer = env.STORAGE_STATS_REFRESH_MINUTES
      ? setInterval(() => void this.refresh(), env.STORAGE_STATS_REFRESH_MINUTES * 60_000)
      : null;
    timer?.unref();
    return () => {
      schedulerRunning = false;
      if (timer) clearInterval(timer);
      if (rescanTimer) clearTimeout(rescanTimer);
      rescanTimer = null;
    };
  },
};
