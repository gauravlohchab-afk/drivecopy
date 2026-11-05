import type { Types } from 'mongoose';
import { FileModel, Folder, Lock, UploadSession, User } from '../models/index.js';
import { logger } from '../lib/logger.js';
import { withLock } from '../lib/lock.js';
import { keySegment, objectKeyFor, s3Service } from './s3.service.js';
import { s3StatsService } from './s3Stats.service.js';

/**
 * Keeps the bucket laid out like the app: users/<account>/<folder>/<folder>/<file name>. An empty
 * zero-byte object ending in "/" makes a folder visible in S3 before it holds any files.
 *
 * Records are the source of truth and always hold each object's current key, so the layout can change
 * in the background without affecting the app. A change only flags what it affects (s3SyncPending);
 * the job below does the S3 work. A file moves by copy, verify, switch the record, delete the original,
 * so it stays available throughout, and anything that fails stays flagged and is retried.
 *
 * S3 has no folders, so two app folders with the same name in the same place share a prefix there.
 * Their files never collide, because a key in use is never reissued.
 */
const MAX_DEPTH = 64;
// S3 keys are limited to 1024 bytes. This leaves room for the 200-byte file name.
const MAX_DIR_BYTES = 800;
const MAX_NAME_ATTEMPTS = 1000;
// S3's limit for a single copy request. Larger objects stay where they are, and keep working.
const MAX_COPY_BYTES = 5 * 1024 ** 3;
const LOCK = 'job:s3-layout';
const LOCK_TTL_MS = 2 * 60_000;
const LOCK_RENEW_MS = 30_000;
const CHECK_EVERY_MS = 5_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
const MAX_PASSES_PER_RUN = 5;

const FOLDER_SEGMENT_BYTES = 100;
const quiet = { timestamps: false } as const; // Where a file sits in S3 is not a change to the file.

export interface MovedObject {
  fileId: string;
  name: string;
  from: string;
  to: string;
}

export interface LayoutResult {
  moved: MovedObject[];
  foldersCreated: string[];
  /** Left flagged, to be retried. */
  failed: { name: string; reason: string }[];
  /** Left where they are for good, and still working. */
  skipped: { name: string; reason: string }[];
  /** The record points at the new object, but the old object could not be removed. */
  leftovers: string[];
}

export async function ownerDir(ownerId: Types.ObjectId) {
  const owner = await User.findById(ownerId, { kind: 1, name: 1, email: 1 }).lean();
  const label = owner?.kind === 'drive' ? `Shared drive - ${owner.name}` : (owner?.email ?? String(ownerId));
  return `users/${keySegment(label, FOLDER_SEGMENT_BYTES, 'account')}/`;
}

/** Where things in this folder (null for the top of the account) belong. Built from current names. */
export async function folderDir(ownerId: Types.ObjectId, folderId: Types.ObjectId | null) {
  const root = await ownerDir(ownerId);
  const segments: string[] = [];
  let current = folderId;
  for (let depth = 0; current && depth <= MAX_DEPTH; depth++) {
    const folder = (await Folder.findOne({ _id: current, ownerId }, { name: 1, parentFolderId: 1 }).lean()) as { name: string; parentFolderId: Types.ObjectId | null } | null;
    if (!folder) break;
    segments.unshift(`${keySegment(folder.name, FOLDER_SEGMENT_BYTES, 'folder')}/`);
    current = folder.parentFolderId;
  }
  const dir = root + segments.join('');
  // Very deep trees can exceed S3's key limit. Those files go at the top of the account instead.
  return Buffer.byteLength(dir) > MAX_DIR_BYTES ? root : dir;
}

/** Removes a folder's S3 marker, unless another folder with the same path still needs it. */
export async function releaseFolderMarker(prefix: string | null | undefined, exceptId?: Types.ObjectId) {
  if (!prefix) return;
  if (await Folder.exists({ s3Prefix: prefix, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })) return;
  await s3Service.deleteObject(prefix);
}

async function isFree(key: string, taken?: Set<string>) {
  if (taken?.has(key)) return false;
  return !((await UploadSession.exists({ s3Key: key })) || (await FileModel.exists({ s3Key: key })) || (await s3Service.head(key)));
}

/** The key a file should have: its current one if that is already right. */
async function desiredKey(dir: string, name: string, current: string, taken?: Set<string>) {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const key = objectKeyFor(dir, name, attempt);
    if (key === current) return current;
    if (await isFree(key, taken)) return key;
  }
  throw new Error('Too many files share this name');
}

/** An object's ETag is its MD5 unless it was uploaded in parts, and a copy gets a new one then. */
async function sameContent(from: string, to: string, source: { size: number; etag?: string }) {
  const copy = await s3Service.head(to);
  if (!copy || copy.size !== source.size) return false;
  if (source.etag && !source.etag.includes('-')) return copy.etag === source.etag;
  return (await s3Service.sha256(from)) === (await s3Service.sha256(to));
}

type FolderRow = { _id: Types.ObjectId; ownerId: Types.ObjectId; name: string; parentFolderId: Types.ObjectId | null; purgePending?: boolean; s3Prefix?: string | null };
type FileRow = { _id: Types.ObjectId; ownerId: Types.ObjectId; name: string; parentFolderId: Types.ObjectId | null; s3Key: string; uploadId: Types.ObjectId; uploadStatus: string; purgePending?: boolean };

async function syncFolder(folder: FolderRow, result: LayoutResult) {
  if (!folder.purgePending) {
    const desired = await folderDir(folder.ownerId, folder._id);
    if (desired !== folder.s3Prefix) {
      await s3Service.putFolderMarker(desired);
      await Folder.updateOne({ _id: folder._id }, { $set: { s3Prefix: desired } }, quiet);
      await releaseFolderMarker(folder.s3Prefix, folder._id);
      const children = { ownerId: folder.ownerId, parentFolderId: folder._id };
      await Folder.updateMany(children, { $set: { s3SyncPending: true } }, quiet);
      await FileModel.updateMany({ ...children, uploadStatus: 'completed', purgePending: false }, { $set: { s3SyncPending: true } }, quiet);
      result.foldersCreated.push(desired);
    }
  }
  // Only if nothing changed meanwhile: a rename during this stays flagged for the next run.
  await Folder.updateOne({ _id: folder._id, name: folder.name, parentFolderId: folder.parentFolderId }, { $set: { s3SyncPending: false } }, quiet);
}

async function syncFile(file: FileRow, result: LayoutResult, onMoved?: (m: MovedObject) => void) {
  const clear = (s3Key: string) =>
    FileModel.updateOne({ _id: file._id, name: file.name, parentFolderId: file.parentFolderId, s3Key }, { $set: { s3SyncPending: false } }, quiet);
  if (file.uploadStatus !== 'completed' || file.purgePending) return clear(file.s3Key);

  const to = await desiredKey(await folderDir(file.ownerId, file.parentFolderId), file.name, file.s3Key);
  if (to === file.s3Key) return clear(file.s3Key);

  const source = await s3Service.head(file.s3Key);
  if (!source) {
    result.skipped.push({ name: file.name, reason: 'Original object not found' });
    return clear(file.s3Key);
  }
  if (source.size > MAX_COPY_BYTES) {
    result.skipped.push({ name: file.name, reason: 'Larger than the 5 GB single-copy limit' });
    return clear(file.s3Key);
  }
  if (!(await s3Service.copyObject(file.s3Key, to))) throw new Error('The new name was taken during the copy');
  if (!(await sameContent(file.s3Key, to, source))) {
    await s3Service.deleteObject(to);
    throw new Error('The copy did not match the original');
  }
  const updated = await FileModel.updateOne({ _id: file._id, s3Key: file.s3Key, purgePending: false }, { $set: { s3Key: to } }, quiet);
  if (!updated.modifiedCount) {
    // Deleted or changed while this ran, so the original is no longer this job's to touch.
    await s3Service.deleteObject(to);
    return;
  }
  await UploadSession.updateOne({ _id: file.uploadId, s3Key: file.s3Key }, { $set: { s3Key: to } }, quiet);
  const entry = { fileId: String(file._id), name: file.name, from: file.s3Key, to };
  onMoved?.(entry);
  result.moved.push(entry);
  try {
    await s3Service.deleteObject(file.s3Key);
  } catch {
    result.leftovers.push(file.s3Key);
  }
  return clear(to);
}

async function drain(onMoved?: (m: MovedObject) => void): Promise<LayoutResult> {
  const result: LayoutResult = { moved: [], foldersCreated: [], failed: [], skipped: [], leftovers: [] };
  let renewedAt = Date.now();
  const renew = async () => {
    if (Date.now() - renewedAt < LOCK_RENEW_MS) return;
    renewedAt = Date.now();
    await Lock.updateOne({ _id: LOCK }, { $set: { expiresAt: new Date(renewedAt + LOCK_TTL_MS) } });
  };
  const note = (name: string, err: unknown) => {
    const reason = (err as { s3Error?: string }).s3Error ?? (err as Error).message;
    logger.warn({ reason }, 'Could not update the S3 layout');
    result.failed.push({ name, reason });
  };

  // An item normally needs one pass, or a few if it keeps changing. The cap means a run always ends:
  // anything still flagged after that is left for the next run.
  const setAside = (seen: Map<string, number>, excluded: Types.ObjectId[], id: Types.ObjectId) => {
    const count = (seen.get(String(id)) ?? 0) + 1;
    seen.set(String(id), count);
    if (count >= MAX_PASSES_PER_RUN) excluded.push(id);
  };

  const excludedFolders: Types.ObjectId[] = [];
  const foldersSeen = new Map<string, number>();
  for (;;) {
    const batch = (await Folder.find({ s3SyncPending: true, _id: { $nin: excludedFolders } }).limit(200).lean()) as unknown as FolderRow[];
    if (!batch.length) break;
    for (const folder of batch) {
      await renew();
      setAside(foldersSeen, excludedFolders, folder._id);
      await syncFolder(folder, result).catch((err) => {
        excludedFolders.push(folder._id);
        note(folder.name, err);
      });
    }
  }
  const excludedFiles: Types.ObjectId[] = [];
  const filesSeen = new Map<string, number>();
  for (;;) {
    const batch = (await FileModel.find({ s3SyncPending: true, _id: { $nin: excludedFiles } }).limit(200).lean()) as unknown as FileRow[];
    if (!batch.length) break;
    for (const file of batch) {
      await renew();
      setAside(filesSeen, excludedFiles, file._id);
      await syncFile(file, result, onMoved).catch((err) => {
        excludedFiles.push(file._id);
        note(file.name, err);
      });
    }
  }
  // The usage totals are unchanged, but a listing that ran during this may have counted both copies.
  if (result.moved.length) await s3StatsService.adjust(0, 0);
  return result;
}

export const s3LayoutService = {
  /** Applies everything flagged. One instance at a time; throws BUSY if another is running. */
  run(onMoved?: (m: MovedObject) => void) {
    return withLock(LOCK, () => drain(onMoved), { ttlMs: LOCK_TTL_MS, waitMs: 0 });
  },

  /** What a full sync would do, changing nothing. */
  async plan() {
    const taken = new Set<string>();
    const moves: Omit<MovedObject, 'fileId'>[] = [];
    const folders: string[] = [];
    for await (const f of Folder.find({ purgePending: false }).lean().cursor()) {
      const dir = await folderDir(f.ownerId as Types.ObjectId, f._id as Types.ObjectId);
      if (dir !== f.s3Prefix && !folders.includes(dir)) folders.push(dir);
    }
    for await (const f of FileModel.find({ uploadStatus: 'completed', purgePending: false }).sort({ _id: 1 }).lean().cursor()) {
      const to = await desiredKey(await folderDir(f.ownerId as Types.ObjectId, f.parentFolderId as Types.ObjectId | null), f.name, f.s3Key, taken);
      taken.add(to);
      if (to !== f.s3Key) moves.push({ name: f.name, from: f.s3Key, to });
    }
    return { moves, folders };
  },

  /**
   * Brings existing data into the layout, in one go or, with a limit, a few files at a time. The flags
   * are set under the lock, so the background job cannot run them without the caller's onMoved.
   */
  syncExisting(opts: { limit?: number; onMoved?: (m: MovedObject) => void }) {
    return withLock(
      LOCK,
      async () => {
        if (opts.limit !== undefined) {
          const { moves } = await this.plan();
          const pick = moves.slice(0, opts.limit).map((m) => m.from);
          await FileModel.updateMany({ s3Key: { $in: pick } }, { $set: { s3SyncPending: true } }, quiet);
        } else {
          await Folder.updateMany({ purgePending: false }, { $set: { s3SyncPending: true } }, quiet);
          await FileModel.updateMany({ uploadStatus: 'completed', purgePending: false }, { $set: { s3SyncPending: true } }, quiet);
        }
        return drain(opts.onMoved);
      },
      { ttlMs: LOCK_TTL_MS, waitMs: 0 },
    );
  },

  /** Flags an account's top level, after a change that affects every path in it. */
  async flagAccount(ownerId: Types.ObjectId) {
    const top = { ownerId, parentFolderId: null };
    await Folder.updateMany({ ...top, purgePending: false }, { $set: { s3SyncPending: true } }, quiet);
    await FileModel.updateMany({ ...top, uploadStatus: 'completed', purgePending: false }, { $set: { s3SyncPending: true } }, quiet);
  },

  startJob() {
    let running = false;
    let retryAt = 0;
    const timer = setInterval(() => {
      if (running || Date.now() < retryAt) return;
      running = true;
      void (async () => {
        try {
          if (!(await Folder.exists({ s3SyncPending: true })) && !(await FileModel.exists({ s3SyncPending: true }))) return;
          const result = await this.run();
          if (result.failed.length) retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
        } catch (err) {
          if ((err as { code?: string }).code !== 'BUSY') {
            retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
            logger.warn({ err: (err as Error).message }, 'S3 layout job failed');
          }
        } finally {
          running = false;
        }
      })();
    }, CHECK_EVERY_MS);
    timer.unref();
    return () => clearInterval(timer);
  },
};
