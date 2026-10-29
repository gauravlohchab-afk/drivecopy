import type { Types } from 'mongoose';
import { FileModel, Settlement, User, UploadSession } from '../models/index.js';
import { notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { s3Service } from './s3.service.js';

export const storageService = {
  /** Official usage comes from the server-side counters (see docs/STORAGE_POLICY.md). */
  async usage(userId: Types.ObjectId) {
    const user = await User.findById(userId, { storageQuota: 1, storageUsed: 1, storageReserved: 1 }).lean();
    if (!user) throw notFound('User');
    const trash = await FileModel.aggregate<{ bytes: number }>([
      { $match: { ownerId: userId, uploadStatus: 'completed', deletedAt: { $ne: null }, purgePending: false } },
      { $group: { _id: null, bytes: { $sum: '$size' } } },
    ]);
    const used = Math.max(0, user.storageUsed);
    const reserved = Math.max(0, user.storageReserved);
    return {
      quota: user.storageQuota,
      used,
      reserved,
      inTrash: trash[0]?.bytes ?? 0,
      remaining: Math.max(0, user.storageQuota - used - reserved),
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
