import type { Types } from 'mongoose';
import { Folder, FileModel, User } from '../models/index.js';
import { notFound } from '../lib/errors.js';
import { treeLock } from '../lib/lock.js';
import { folderDto, fileDto } from '../lib/serialize.js';
import { logger } from '../lib/logger.js';
import { activeFilter, descendantFolderIds } from './folder.service.js';
import { s3Service } from './s3.service.js';

type Owner = { userId: Types.ObjectId; userIdStr: string };

/**
 * Trash model
 * - Moving an item to Trash sets deletedAt on it and on every *active* descendant, and stamps all
 *   of them with trashRootId = the item the user trashed. Only trash roots are listed in Trash.
 * - Items that were already in Trash keep their own trashRootId, so they stay independently
 *   restorable.
 * - Restore clears the whole group. If the original parent is gone or itself in Trash, the root
 *   is restored to the top of My Drive instead of becoming invisible.
 * - Permanent deletion marks the group purgePending (hidden everywhere) and the purge routine
 *   deletes S3 objects first, then metadata. Failures stay pending and are retried.
 * - Trashed files keep counting toward storage until they are permanently deleted.
 */
export const trashService = {
  async trashFolder(owner: Owner, folderId: Types.ObjectId) {
    return treeLock(owner.userIdStr, async () => {
      const folder = await Folder.findOne({ _id: folderId, ...activeFilter(owner.userId) });
      if (!folder) throw notFound('Folder');
      const now = new Date();
      const descendants = await descendantFolderIds(owner.userId, folderId, { deletedAt: null, purgePending: false });
      const folderIds = [folderId, ...descendants];
      const stamp = { $set: { deletedAt: now, trashRootId: folderId } };
      await Folder.updateMany({ ownerId: owner.userId, _id: { $in: folderIds }, deletedAt: null }, stamp);
      await FileModel.updateMany({ ownerId: owner.userId, parentFolderId: { $in: folderIds }, deletedAt: null, purgePending: false }, stamp);
      return { trashed: true };
    });
  },

  async trashFile(owner: Owner, fileId: Types.ObjectId) {
    const res = await FileModel.updateOne(
      { _id: fileId, ...activeFilter(owner.userId), uploadStatus: 'completed' },
      { $set: { deletedAt: new Date(), trashRootId: fileId } },
    );
    if (res.matchedCount === 0) throw notFound('File');
    return { trashed: true };
  },

  async list(owner: Owner) {
    // Only trash roots are listed; their descendants come back with them on restore.
    const base = { ownerId: owner.userId, deletedAt: { $ne: null }, trashRootId: { $ne: null }, purgePending: false };
    const isRoot = (d: { _id: unknown; trashRootId?: unknown }) => String(d._id) === String(d.trashRootId);
    const [folders, files] = await Promise.all([
      Folder.find(base).sort({ deletedAt: -1 }).lean(),
      FileModel.find({ ...base, uploadStatus: 'completed' }).sort({ deletedAt: -1 }).lean(),
    ]);
    return { folders: folders.filter(isRoot).map(folderDto), files: files.filter(isRoot).map(fileDto) };
  },

  async findRoot(owner: Owner, id: Types.ObjectId) {
    const q = { _id: id, ownerId: owner.userId, trashRootId: id, deletedAt: { $ne: null }, purgePending: false };
    const folder = await Folder.findOne(q);
    if (folder) return { kind: 'folder' as const, doc: folder };
    const file = await FileModel.findOne({ ...q, uploadStatus: 'completed' });
    if (file) return { kind: 'file' as const, doc: file };
    throw notFound('Item in Trash');
  },

  async restore(owner: Owner, id: Types.ObjectId) {
    return treeLock(owner.userIdStr, async () => {
      const root = await this.findRoot(owner, id);
      let restoredToRoot = false;
      const parentId = root.doc.parentFolderId as Types.ObjectId | null;
      if (parentId) {
        const parentActive = await Folder.exists({ _id: parentId, ...activeFilter(owner.userId) });
        if (!parentActive) {
          root.doc.parentFolderId = null;
          await root.doc.save();
          restoredToRoot = true;
        }
      }
      const unstamp = { $set: { deletedAt: null, trashRootId: null } };
      await Folder.updateMany({ ownerId: owner.userId, trashRootId: id, purgePending: false }, unstamp);
      await FileModel.updateMany({ ownerId: owner.userId, trashRootId: id, purgePending: false }, unstamp);
      return { restored: true, restoredToRoot, kind: root.kind };
    });
  },

  async permanentDelete(owner: Owner, id: Types.ObjectId) {
    await treeLock(owner.userIdStr, async () => {
      await this.findRoot(owner, id);
      await markForPurge(owner.userId, { trashRootId: id });
    });
    return purgeService.run(owner.userId);
  },

  async empty(owner: Owner) {
    await treeLock(owner.userIdStr, async () => {
      await markForPurge(owner.userId, { deletedAt: { $ne: null } });
    });
    return purgeService.run(owner.userId);
  },
};

async function markForPurge(ownerId: Types.ObjectId, filter: Record<string, unknown>) {
  await Folder.updateMany({ ownerId, ...filter }, { $set: { purgePending: true } });
  await FileModel.updateMany({ ownerId, ...filter }, { $set: { purgePending: true } });
}

export const purgeService = {
  /**
   * Deletes S3 objects for purge-pending files, then their metadata, then empty purge-pending
   * folders. MongoDB and S3 share no transaction, so the order matters: metadata is only removed
   * after S3 confirmed the delete, and anything that failed stays pending for the next run.
   */
  async run(ownerId?: Types.ObjectId) {
    const scope = ownerId ? { ownerId } : {};
    let deletedFiles = 0;
    let failedFiles = 0;
    let freedBytes = 0;

    for (;;) {
      const batch = await FileModel.find({ ...scope, purgePending: true }, { s3Key: 1, size: 1, ownerId: 1, uploadStatus: 1 })
        .sort({ _id: 1 })
        .skip(failedFiles)
        .limit(500)
        .lean();
      if (!batch.length) break;
      const { failed } = await s3Service.deleteObjects(batch.map((f) => f.s3Key));
      const failedSet = new Set(failed);
      for (const f of batch) {
        if (failedSet.has(f.s3Key)) {
          failedFiles++;
          continue;
        }
        const removed = await FileModel.findOneAndDelete({ _id: f._id, purgePending: true }).lean();
        if (removed && removed.uploadStatus === 'completed') {
          await User.updateOne({ _id: removed.ownerId }, { $inc: { storageUsed: -removed.size } });
          freedBytes += removed.size;
        }
        if (removed) deletedFiles++;
      }
      if (failed.length) logger.warn({ failed: failed.length }, 'Some S3 deletes failed; they will be retried');
    }

    // Folders go once none of their purge-pending files remain. Items that were trashed on their
    // own earlier (and are not being purged) are moved to the root instead of being orphaned.
    const folders = await Folder.find({ ...scope, purgePending: true }, { _id: 1, ownerId: 1 }).lean();
    let deletedFolders = 0;
    for (const folder of folders) {
      const pendingChildren = await FileModel.exists({ parentFolderId: folder._id, purgePending: true });
      if (pendingChildren) continue;
      const survivors = { ownerId: folder.ownerId, parentFolderId: folder._id, purgePending: false };
      await FileModel.updateMany(survivors, { $set: { parentFolderId: null } });
      await Folder.updateMany(survivors, { $set: { parentFolderId: null } });
      const res = await Folder.deleteOne({ _id: folder._id, purgePending: true });
      deletedFolders += res.deletedCount;
    }

    return { deletedFiles, deletedFolders, freedBytes, pendingRetries: failedFiles };
  },
};
