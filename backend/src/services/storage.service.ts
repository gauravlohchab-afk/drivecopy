import type { Types } from 'mongoose';
import { FileModel, Folder, Settlement, User, UploadSession } from '../models/index.js';
import { folderDto } from '../lib/serialize.js';
import { notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { s3Service } from './s3.service.js';

/** Folder sizes are rolled up in memory; very large trees are capped to keep the request bounded. */
const FOLDER_SCAN_CAP = 20_000;

export const storageService = {
  /** One owner's share of the bucket, from the server-side counters. There is no quota. */
  async usage(userId: Types.ObjectId) {
    const user = await User.findById(userId, { storageUsed: 1, storageReserved: 1 }).lean();
    if (!user) throw notFound('User');
    const trash = await FileModel.aggregate<{ bytes: number }>([
      { $match: { ownerId: userId, uploadStatus: 'completed', deletedAt: { $ne: null }, purgePending: false } },
      { $group: { _id: null, bytes: { $sum: '$size' } } },
    ]);
    const used = Math.max(0, user.storageUsed);
    const reserved = Math.max(0, user.storageReserved);
    return { used, reserved, inTrash: trash[0]?.bytes ?? 0 };
  },

  /**
   * Where the space goes: active (not trashed) files by category, and the folders holding the most
   * data including everything nested inside them. Computed from metadata on request.
   */
  async breakdown(userId: Types.ObjectId) {
    const active = { ownerId: userId, uploadStatus: 'completed', deletedAt: null, purgePending: false };
    const [byCategory, byParent, folders] = await Promise.all([
      FileModel.aggregate<{ _id: string; bytes: number; count: number }>([
        { $match: active },
        { $group: { _id: '$category', bytes: { $sum: '$size' }, count: { $sum: 1 } } },
        { $sort: { bytes: -1 } },
      ]),
      FileModel.aggregate<{ _id: Types.ObjectId | null; bytes: number }>([
        { $match: active },
        { $group: { _id: '$parentFolderId', bytes: { $sum: '$size' } } },
      ]),
      Folder.find({ ownerId: userId, deletedAt: null, purgePending: false }).limit(FOLDER_SCAN_CAP).lean(),
    ]);

    // Roll each folder's direct bytes up to all of its ancestors.
    const byId = new Map(folders.map((f) => [String(f._id), f]));
    const totals = new Map<string, number>();
    for (const { _id, bytes } of byParent) {
      let current = _id ? byId.get(String(_id)) : undefined;
      for (let depth = 0; current && depth <= 64; depth++) {
        totals.set(String(current._id), (totals.get(String(current._id)) ?? 0) + bytes);
        current = current.parentFolderId ? byId.get(String(current.parentFolderId)) : undefined;
      }
    }
    const largestFolders = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, bytes]) => ({ folder: folderDto(byId.get(id)!), bytes }));

    return {
      byCategory: byCategory.map((c) => ({ category: c._id, bytes: c.bytes, count: c.count })),
      largestFolders,
    };
  },

  /**
   * Recomputes a user's counters from metadata: used = sum of completed files that are not yet
   * purged (Trash included); reserved = sum of open upload sessions that have not settled.
   */
  async reconcileUser(userId: Types.ObjectId) {
    const [usedAgg, open] = await Promise.all([
      FileModel.aggregate<{ bytes: number }>([
        { $match: { ownerId: userId, uploadStatus: 'completed' } },
        { $group: { _id: null, bytes: { $sum: '$size' } } },
      ]),
      UploadSession.find({ ownerId: userId, status: { $in: ['pending', 'uploading', 'verifying'] } }, { expectedSize: 1 }).lean(),
    ]);
    const settled = await Settlement.find({ _id: { $in: open.map((s) => s._id) } }, { _id: 1 }).lean();
    const settledIds = new Set(settled.map((s) => String(s._id)));
    const storageUsed = usedAgg[0]?.bytes ?? 0;
    const storageReserved = open.filter((s) => !settledIds.has(String(s._id))).reduce((sum, s) => sum + s.expectedSize, 0);
    const before = await User.findByIdAndUpdate(userId, { $set: { storageUsed, storageReserved } }).lean();
    return { userId: String(userId), before: before ? { used: before.storageUsed, reserved: before.storageReserved } : null, after: { used: storageUsed, reserved: storageReserved } };
  },

  /**
   * Compares metadata with S3. Reports (and optionally removes) objects with no metadata record,
   * and reports completed files whose object is missing. Read-only unless deleteOrphans is set.
   */
  async reconcileObjects(opts: { deleteOrphans: boolean }) {
    const orphanObjects: string[] = [];
    for await (const obj of s3Service.listObjects('users/')) {
      if (obj.key.endsWith('/')) continue; // A folder marker, not a file.
      const known = (await FileModel.exists({ s3Key: obj.key })) || (await UploadSession.exists({ s3Key: obj.key }));
      // Give in-flight uploads a day before calling an object an orphan.
      if (!known && obj.lastModified && obj.lastModified.getTime() < Date.now() - 24 * 3600_000) orphanObjects.push(obj.key);
    }
    const missingObjects: string[] = [];
    const cursor = FileModel.find({ uploadStatus: 'completed', purgePending: false }, { s3Key: 1 }).lean().cursor();
    for await (const f of cursor) {
      if (!(await s3Service.head(f.s3Key))) missingObjects.push(String(f._id));
    }
    if (opts.deleteOrphans && orphanObjects.length) {
      const { failed } = await s3Service.deleteObjects(orphanObjects);
      if (failed.length) logger.warn({ failed: failed.length }, 'Orphan deletion incomplete');
    }
    return { orphanObjects, missingObjects };
  },
};
