import { Lock } from '../models/index.js';
import { AppError } from './errors.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Serialises folder-tree mutations per user (moves, trash, restore, purge). Without this, two
 * concurrent moves (A into B, B into A) could each pass the cycle check and create a loop.
 * The lock lives in MongoDB so it holds across multiple API instances; a TTL index removes
 * locks left behind by a crashed process.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>, opts: { ttlMs?: number; waitMs?: number } = {}): Promise<T> {
  const ttlMs = opts.ttlMs ?? 60_000;
  const deadline = Date.now() + (opts.waitMs ?? 5_000);
  for (let attempt = 0; ; attempt++) {
    try {
      await Lock.create({ _id: name, expiresAt: new Date(Date.now() + ttlMs) });
      break;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      // TTL monitor runs about once a minute; clear clearly expired locks ourselves.
      await Lock.deleteOne({ _id: name, expiresAt: { $lt: new Date() } });
      if (Date.now() > deadline) throw new AppError(409, 'BUSY', 'Another change is in progress. Please try again.');
      await sleep(Math.min(50 * 2 ** attempt, 400));
    }
  }
  try {
    return await fn();
  } finally {
    await Lock.deleteOne({ _id: name }).catch(() => undefined);
  }
}

export const treeLock = <T>(ownerId: string, fn: () => Promise<T>) => withLock(`tree:${ownerId}`, fn);
