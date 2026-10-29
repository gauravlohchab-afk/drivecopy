import type { Types } from 'mongoose';
import { FileModel } from '../models/index.js';
import { notFound, AppError } from '../lib/errors.js';
import { treeLock } from '../lib/lock.js';
import { keyset, encodeCursor, SORT_FIELDS, type ListQuery } from '../lib/pagination.js';
import { fileDto } from '../lib/serialize.js';
import { inlinePreviewAllowed } from '../lib/fileTypes.js';
import { activeFilter, resolveDestination } from './folder.service.js';
import { s3Service } from './s3.service.js';
import { env } from '../config/env.js';

type Owner = { userId: Types.ObjectId; userIdStr: string };

const activeFile = (ownerId: Types.ObjectId) => ({ ...activeFilter(ownerId), uploadStatus: 'completed' as const });

async function getActiveFile(ownerId: Types.ObjectId, fileId: Types.ObjectId) {
  const file = await FileModel.findOne({ _id: fileId, ...activeFile(ownerId) });
  if (!file) throw notFound('File');
  return file;
}

function expiresAt() {
  return new Date(Date.now() + env.PRESIGNED_URL_TTL_SECONDS * 1000).toISOString();
}

export const fileService = {
  async list(owner: Owner, folderId: Types.ObjectId | null, q: ListQuery) {
    await resolveDestination(owner.userId, folderId);
    const field = SORT_FIELDS[q.sort];
    const { sort, filter } = keyset(field, q.order, q.cursor);
    const docs = await FileModel.find({ ...activeFile(owner.userId), parentFolderId: folderId, ...filter }).sort(sort).limit(q.limit + 1).lean();
    const page = docs.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map(fileDto), nextCursor: docs.length > q.limit && last ? encodeCursor(last as Record<string, unknown>, field) : null };
  },

  async get(owner: Owner, fileId: Types.ObjectId) {
    return fileDto((await getActiveFile(owner.userId, fileId)).toObject());
  },

  /** Rename / star. Metadata only: the S3 object is never copied. */
  async update(owner: Owner, fileId: Types.ObjectId, patch: { name?: string; isStarred?: boolean }) {
    const set: Record<string, unknown> = { ...patch };
    if (patch.name) set.nameLower = patch.name.toLowerCase();
    if (patch.name) set.lastActivityAt = new Date();
    const file = await FileModel.findOneAndUpdate({ _id: fileId, ...activeFile(owner.userId) }, { $set: set }, { new: true, runValidators: true }).lean();
    if (!file) throw notFound('File');
    return fileDto(file);
  },

  /** Moving changes parentFolderId only; the object key is independent of the folder tree. */
  async move(owner: Owner, fileId: Types.ObjectId, destinationId: Types.ObjectId | null) {
    return treeLock(owner.userIdStr, async () => {
      await resolveDestination(owner.userId, destinationId);
      const file = await FileModel.findOneAndUpdate(
        { _id: fileId, ...activeFile(owner.userId) },
        { $set: { parentFolderId: destinationId, lastActivityAt: new Date() } },
        { new: true },
      ).lean();
      if (!file) throw notFound('File');
      return fileDto(file);
    });
  },

  async previewUrl(owner: Owner, fileId: Types.ObjectId) {
    const file = await getActiveFile(owner.userId, fileId);
    if (!inlinePreviewAllowed(file.mimeType)) {
      throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'Preview is not available for this file type. Download it instead.');
    }
    const url = await s3Service.presignGet(file.s3Key, { disposition: 'inline', filename: file.name, contentType: file.mimeType });
    await FileModel.updateOne({ _id: file._id }, { $set: { lastActivityAt: new Date() } }, { timestamps: false });
    return { url, expiresAt: expiresAt(), mimeType: file.mimeType, category: file.category };
  },

  async downloadUrl(owner: Owner, fileId: Types.ObjectId) {
    const file = await getActiveFile(owner.userId, fileId);
    const url = await s3Service.presignGet(file.s3Key, { disposition: 'attachment', filename: file.name, contentType: file.mimeType });
    await FileModel.updateOne({ _id: file._id }, { $set: { lastActivityAt: new Date() } }, { timestamps: false });
    return { url, expiresAt: expiresAt() };
  },

  /** Short-lived inline URLs for image thumbnails in the grid view (owned images only). */
  async thumbnailUrls(owner: Owner, ids: Types.ObjectId[]) {
    const files = await FileModel.find({ _id: { $in: ids }, ...activeFile(owner.userId), category: 'image' }).lean();
    const out: Record<string, string> = {};
    await Promise.all(
      files
        .filter((f) => inlinePreviewAllowed(f.mimeType))
        .map(async (f) => {
          out[String(f._id)] = await s3Service.presignGet(f.s3Key, { disposition: 'inline', filename: f.name, contentType: f.mimeType });
        }),
    );
    return { urls: out, expiresAt: expiresAt() };
  },
};
