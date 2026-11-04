import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import { Activity, ActivityOutbox, Migration, User } from '../models/index.js';
import { AppError, badRequest } from '../lib/errors.js';
import { withLock } from '../lib/lock.js';
import { logger } from '../lib/logger.js';
import { ACTIVITY_PREFIX, s3Service } from './s3.service.js';

/**
 * The activity log lives in S3 as JSON Lines: activity-logs/YYYY/MM/DD/activity-<time>-<uuid>.jsonl
 *
 * Writing: an event is saved to a MongoDB outbox first, then batches are written to S3 as new
 * objects and only then removed from the outbox. An S3 outage or missing permission therefore delays
 * events without losing them, and objects are never modified after they are written. If the process
 * dies between the S3 write and the outbox delete, a batch can be written twice; readers drop the
 * repeat by eventId.
 *
 * Reading: S3 cannot query, so the feed walks days and objects newest first and filters as it goes.
 * Date filters skip whole days without reading them, and the work per request is capped.
 */
export type ItemKind = 'file' | 'folder' | 'drive';
export type AuthEvent = 'login' | 'login_failed' | 'logout';
export type RecordableAction = 'upload' | 'download' | 'preview' | 'create_folder' | 'rename' | 'move' | 'trash' | 'restore' | 'delete' | 'share' | 'unshare' | 'permission_change';
export type ActivityCategory = 'file' | 'folder' | 'sharing' | 'auth';

type Item = { _id: unknown; ownerId: unknown; name: string; size?: number; mimeType?: string };

export interface ActivityEvent {
  actorId: Types.ObjectId;
  action: RecordableAction;
  kind: ItemKind;
  item: Item;
  detail?: string | null;
  targetUserId?: Types.ObjectId | null;
}

export interface ActivityRecord {
  eventId: string;
  eventType: string;
  userId: string | null;
  fileId?: string;
  fileName?: string;
  folderId?: string;
  folderName?: string;
  action: string;
  details: Record<string, unknown>;
  /** Always UTC. */
  timestamp: string;
  status: 'SUCCESS' | 'FAILED';
}

const FILE_EVENTS: Partial<Record<RecordableAction, [string, string]>> = {
  upload: ['FILE_UPLOADED', 'Uploaded a file'],
  download: ['FILE_DOWNLOADED', 'Downloaded a file'],
  preview: ['FILE_PREVIEWED', 'Previewed a file'],
  rename: ['FILE_RENAMED', 'Renamed a file'],
  move: ['FILE_MOVED', 'Moved a file'],
  trash: ['FILE_DELETED', 'Moved a file to Trash'],
  restore: ['FILE_RESTORED', 'Restored a file'],
  delete: ['FILE_PERMANENTLY_DELETED', 'Permanently deleted a file'],
  share: ['FILE_SHARED', 'Shared a file'],
  unshare: ['FILE_ACCESS_REVOKED', 'Revoked access to a file'],
};
const FOLDER_EVENTS: Partial<Record<RecordableAction, [string, string]>> = {
  create_folder: ['FOLDER_CREATED', 'Created a folder'],
  rename: ['FOLDER_RENAMED', 'Renamed a folder'],
  move: ['FOLDER_MOVED', 'Moved a folder'],
  trash: ['FOLDER_DELETED', 'Moved a folder to Trash'],
  restore: ['FOLDER_RESTORED', 'Restored a folder'],
  delete: ['FOLDER_PERMANENTLY_DELETED', 'Permanently deleted a folder'],
  share: ['FOLDER_SHARED', 'Shared a folder'],
  unshare: ['FOLDER_ACCESS_REVOKED', 'Revoked access to a folder'],
};
const DRIVE_EVENTS: Partial<Record<RecordableAction, [string, string]>> = {
  permission_change: ['SHARING_PERMISSIONS_CHANGED', 'Changed sharing permissions'],
};
const AUTH_EVENTS: Record<AuthEvent, [string, string, ActivityRecord['status']]> = {
  login: ['LOGIN_SUCCESSFUL', 'Signed in', 'SUCCESS'],
  login_failed: ['LOGIN_FAILED', 'Failed sign-in attempt', 'FAILED'],
  logout: ['LOGOUT', 'Signed out', 'SUCCESS'],
};

function categoryOf(eventType: string): ActivityCategory {
  if (eventType.startsWith('LOG')) return 'auth';
  if (/SHARED|SHARING|REVOKED/.test(eventType)) return 'sharing';
  return eventType.startsWith('FOLDER') ? 'folder' : 'file';
}

function toRecord(e: ActivityEvent, at = new Date()): ActivityRecord | null {
  const table = e.kind === 'file' ? FILE_EVENTS : e.kind === 'folder' ? FOLDER_EVENTS : DRIVE_EVENTS;
  const entry = table[e.action];
  if (!entry) return null;
  const id = String(e.item._id);
  const details: Record<string, unknown> = {};
  if (e.kind === 'file') {
    if (typeof e.item.size === 'number') details.fileSize = e.item.size;
    if (e.item.mimeType) details.mimeType = e.item.mimeType;
  }
  if (e.kind === 'drive') Object.assign(details, { driveId: id, driveName: e.item.name });
  if (e.targetUserId) details.targetUserId = String(e.targetUserId);
  if (e.detail) {
    const field = { rename: 'previousName', move: 'destination', permission_change: 'role' }[e.action as string];
    if (field) details[field] = e.detail;
  }
  return {
    eventId: randomUUID(),
    eventType: entry[0],
    userId: String(e.actorId),
    ...(e.kind === 'file' ? { fileId: id, fileName: e.item.name } : {}),
    ...(e.kind === 'folder' ? { folderId: id, folderName: e.item.name } : {}),
    action: entry[1],
    details,
    timestamp: at.toISOString(),
    status: 'SUCCESS',
  };
}

const dayOf = (timestamp: string) => timestamp.slice(0, 10).replace(/-/g, '/');
const compactTime = (timestamp: string) => timestamp.replace(/[-:.]/g, '');
const newBatchKey = (day: string, lastTimestamp: string) => `${ACTIVITY_PREFIX}${day}/activity-${compactTime(lastTimestamp)}-${randomUUID()}.jsonl`;
// Sorts before every real batch of the day, since this history came first. Being fixed per day, a
// retry of the copy finds it already there rather than writing it twice.
const legacyBatchKey = (day: string) => `${ACTIVITY_PREFIX}${day}/activity-00000000T000000000Z-legacy.jsonl`;
const toJsonl = (records: ActivityRecord[]) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

function byDay(records: ActivityRecord[]) {
  const days = new Map<string, ActivityRecord[]>();
  for (const r of records) {
    const day = dayOf(r.timestamp);
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(r);
  }
  return days;
}

const BATCH_SIZE = 500;
const RETRY_AFTER_FAILURE_MS = 60_000;
const LEGACY_MIGRATION = 'activity-to-s3';

let dirty = true;
let lastFlushError: string | null = null;

// A permission error will not fix itself within seconds, so page views stop waiting on S3 for a while
// and answer from the outbox. The background job keeps trying, so access returns without a restart.
const PERMISSION_ERRORS = new Set(['AccessDenied', 'AllAccessDisabled', 'InvalidAccessKeyId', 'SignatureDoesNotMatch']);
let deniedUntil = 0;

function causeOf(err: unknown) {
  const cause = (err as { s3Error?: string }).s3Error ?? (err as Error).name;
  if (PERMISSION_ERRORS.has(cause)) deniedUntil = Date.now() + RETRY_AFTER_FAILURE_MS;
  return cause;
}

/** One time: copies the older history out of MongoDB. The originals stay where they are. */
async function copyLegacyHistory() {
  if (await Migration.exists({ _id: LEGACY_MIGRATION })) return;
  const docs = await Activity.find().sort({ createdAt: 1, _id: 1 }).lean();
  const records = docs.flatMap((d) => {
    const record = toRecord(
      { actorId: d.actorId, action: d.action, kind: d.itemKind, item: { _id: d.itemId, ownerId: d.ownerId, name: d.itemName }, detail: d.detail, targetUserId: d.targetUserId },
      d.createdAt,
    );
    return record ? [record] : [];
  });
  for (const [day, batch] of byDay(records)) await s3Service.putActivityLog(legacyBatchKey(day), toJsonl(batch));
  await Migration.updateOne({ _id: LEGACY_MIGRATION }, { $setOnInsert: { completedAt: new Date() } }, { upsert: true });
}

async function writePending() {
  await copyLegacyHistory();
  for (;;) {
    const pending = await ActivityOutbox.find().sort({ _id: 1 }).limit(BATCH_SIZE).lean();
    if (!pending.length) return;
    const records = pending.map((p) => p.event as ActivityRecord).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (const [day, batch] of byDay(records)) {
      await s3Service.putActivityLog(newBatchKey(day, batch[batch.length - 1]!.timestamp), toJsonl(batch));
    }
    await ActivityOutbox.deleteMany({ _id: { $in: pending.map((p) => p._id) } });
  }
}

// Written objects never change, so what has been read can be kept.
const CACHED_OBJECTS = 64;
const objectCache = new Map<string, ActivityRecord[]>();

async function readBatch(key: string) {
  const cached = objectCache.get(key);
  if (cached) return cached;
  const text = await s3Service.readText(key);
  const records: ActivityRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ActivityRecord;
      records.push({ ...parsed, details: parsed.details ?? {} });
    } catch {
      logger.warn({ key }, 'Skipped an unreadable activity record');
    }
  }
  records.reverse(); // Oldest first in the file, newest first in the feed.
  objectCache.set(key, records);
  if (objectCache.size > CACHED_OBJECTS) objectCache.delete(objectCache.keys().next().value!);
  return records;
}

const newestFirst = (values: string[]) => [...values].sort((a, b) => b.localeCompare(a));

/** Days that have logs, newest first, listing only as far as the caller actually reads. */
async function* daysNewestFirst() {
  for (const year of newestFirst(await s3Service.listPrefixes(ACTIVITY_PREFIX))) {
    for (const month of newestFirst(await s3Service.listPrefixes(year))) {
      for (const day of newestFirst(await s3Service.listPrefixes(month))) {
        yield day.slice(ACTIVITY_PREFIX.length, -1);
      }
    }
  }
}

export interface FeedQuery {
  limit: number;
  cursor?: string;
  q?: string;
  category?: ActivityCategory;
  status?: 'SUCCESS' | 'FAILED';
  from?: Date;
  to?: Date;
}

/** Where the next page starts. k: the object (null for the first one). i: position within it. */
type Cursor = { k: string | null; i: number };

function encodeFeedCursor(c: Cursor) {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeFeedCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Cursor;
    const validKey = c.k === null || (typeof c.k === 'string' && c.k.startsWith(ACTIVITY_PREFIX) && /^activity-logs\/\d{4}\/\d{2}\/\d{2}\/[\w.-]+$/.test(c.k));
    if (validKey && Number.isInteger(c.i) && c.i >= 0) return c;
  } catch {
    // Reported below.
  }
  throw badRequest('Invalid cursor');
}

// Keeps one request bounded when a narrow filter has to look through a lot of history. Hitting the
// cap ends the page early, with a cursor to carry on from.
const MAX_OBJECTS_PER_REQUEST = 100;

const nameOf = (r: ActivityRecord) => r.fileName ?? r.folderName ?? (r.details.driveName as string | undefined) ?? '';

function matcher(q: FeedQuery) {
  const term = q.q?.toLowerCase();
  const from = q.from?.getTime();
  const to = q.to?.getTime();
  return (r: ActivityRecord) => {
    if (q.category && categoryOf(r.eventType) !== q.category) return false;
    if (q.status && r.status !== q.status) return false;
    const at = new Date(r.timestamp).getTime();
    if (from !== undefined && at < from) return false;
    if (to !== undefined && at > to) return false;
    return !term || nameOf(r).toLowerCase().includes(term) || r.action.toLowerCase().includes(term) || r.eventType.toLowerCase().includes(term);
  };
}

async function readFeedFromS3(q: FeedQuery, start: Cursor | null, room: number, accept: (r: ActivityRecord) => boolean) {
  const out: ActivityRecord[] = [];
  const seen = new Set<string>();
  const startDay = start?.k ? start.k.slice(ACTIVITY_PREFIX.length, ACTIVITY_PREFIX.length + 10) : null;
  const toDay = q.to ? dayOf(q.to.toISOString()) : null;
  const fromDay = q.from ? dayOf(q.from.toISOString()) : null;
  let objectsRead = 0;
  for await (const day of daysNewestFirst()) {
    if ((startDay && day > startDay) || (toDay && day > toDay)) continue;
    if (fromDay && day < fromDay) break;
    const keys: string[] = [];
    for await (const obj of s3Service.listObjects(`${ACTIVITY_PREFIX}${day}/`)) keys.push(obj.key);
    for (const key of newestFirst(keys)) {
      if (start?.k && key > start.k) continue;
      const records = await readBatch(key);
      objectsRead++;
      for (let i = key === start?.k ? start.i : 0; i < records.length; i++) {
        const r = records[i]!;
        if (seen.has(r.eventId) || !accept(r)) continue;
        if (out.length === room) return { records: out, next: { k: key, i } };
        seen.add(r.eventId);
        out.push(r);
      }
      if (objectsRead >= MAX_OBJECTS_PER_REQUEST) return { records: out, next: { k: key, i: records.length } };
    }
  }
  return { records: out, next: null };
}

export const activityService = {
  /** Logging must never fail the operation it describes, so errors are logged and swallowed. */
  async record(e: ActivityEvent) {
    const record = toRecord(e);
    if (record) await this.enqueue(record);
  },

  async recordMany(events: ActivityEvent[]) {
    await Promise.all(events.map((e) => this.record(e)));
  },

  /** Passwords, tokens and whatever was typed as a username are never part of these. */
  async recordAuth(event: AuthEvent, userId: Types.ObjectId | null, ip?: string) {
    const [eventType, action, status] = AUTH_EVENTS[event];
    await this.enqueue({
      eventId: randomUUID(),
      eventType,
      userId: userId ? String(userId) : null,
      action,
      details: ip ? { ip } : {},
      timestamp: new Date().toISOString(),
      status,
    });
  },

  async enqueue(record: ActivityRecord) {
    try {
      await ActivityOutbox.create({ event: record });
      dirty = true;
    } catch (err) {
      logger.warn({ err: (err as Error).message, eventType: record.eventType }, 'Could not record activity');
    }
  },

  /** Writes pending events to S3. What fails stays pending and is retried. */
  async flush(waitMs = 0) {
    await withLock(
      'job:activity-flush',
      async () => {
        dirty = false;
        try {
          await writePending();
          lastFlushError = null;
          deniedUntil = 0;
        } catch (err) {
          dirty = true;
          lastFlushError = causeOf(err);
          throw err;
        }
      },
      { ttlMs: 2 * 60_000, waitMs },
    );
  },

  startFlusher() {
    let retryAt = 0;
    const timer = setInterval(() => {
      if (!dirty || Date.now() < retryAt) return;
      this.flush().catch((err) => {
        if ((err as { code?: string }).code === 'BUSY') return;
        retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
        logger.warn({ cause: lastFlushError }, 'Activity events are waiting to be written to S3');
      });
    }, env.ACTIVITY_FLUSH_SECONDS * 1000);
    timer.unref();
    return () => clearInterval(timer);
  },

  /** Newest first. The first page also includes events still waiting to reach S3. */
  async feed(viewerId: Types.ObjectId, q: FeedQuery) {
    const start = q.cursor ? decodeFeedCursor(q.cursor) : null;
    const denied = () => Date.now() < deniedUntil;
    if (!denied()) await this.flush(2_000).catch(() => undefined);
    const accept = matcher(q);

    const records: ActivityRecord[] = [];
    const seen = new Set<string>();
    if (!start) {
      const pending = await ActivityOutbox.find().sort({ _id: -1 }).limit(q.limit).lean();
      for (const p of pending) {
        const r = p.event as ActivityRecord;
        if (accept(r)) {
          seen.add(r.eventId);
          records.push(r);
        }
      }
    }

    let next: Cursor | null = null;
    let storageError: string | null = lastFlushError;
    if (denied()) {
      storageError ??= 'AccessDenied';
    } else if (records.length < q.limit) {
      try {
        const page = await readFeedFromS3(q, start, q.limit - records.length, (r) => !seen.has(r.eventId) && accept(r));
        records.push(...page.records);
        next = page.next;
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        storageError = causeOf(err);
      }
    } else {
      next = { k: null, i: 0 };
    }

    return {
      items: await present(records, viewerId),
      nextCursor: next ? encodeFeedCursor(next) : null,
      logStorage: {
        status: storageError ? ('degraded' as const) : ('ok' as const),
        pendingEvents: await ActivityOutbox.estimatedDocumentCount(),
        reason: storageError,
      },
    };
  },
};

async function present(records: ActivityRecord[], viewerId: Types.ObjectId) {
  const ids = new Set<string>();
  for (const r of records) {
    for (const id of [r.userId, r.details.targetUserId as string | undefined]) if (id && Types.ObjectId.isValid(id)) ids.add(id);
  }
  const users = await User.find({ _id: { $in: [...ids].map((id) => new Types.ObjectId(id)) } }, { name: 1 }).lean();
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  const person = (id: unknown) => (typeof id === 'string' ? { id, name: names.get(id) ?? 'Deleted user', isYou: id === String(viewerId) } : null);
  return records.map((r) => {
    const details = { ...r.details };
    delete details.targetUserId;
    return {
      id: r.eventId,
      eventType: r.eventType,
      category: categoryOf(r.eventType),
      action: r.action,
      status: r.status,
      at: r.timestamp,
      actor: person(r.userId),
      target: person(r.details.targetUserId),
      item: r.fileId
        ? { id: r.fileId, kind: 'file' as const, name: r.fileName ?? '' }
        : r.folderId
          ? { id: r.folderId, kind: 'folder' as const, name: r.folderName ?? '' }
          : r.details.driveId
            ? { id: String(r.details.driveId), kind: 'drive' as const, name: String(r.details.driveName ?? '') }
            : null,
      details,
    };
  });
}
