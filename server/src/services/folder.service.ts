import type { Types } from 'mongoose';
import { Folder, FileModel } from '../models/index.js';
import { AppError, notFound } from '../lib/errors.js';
import { treeLock } from '../lib/lock.js';
import { keyset, encodeCursor, SORT_FIELDS, type ListQuery } from '../lib/pagination.js';
import { folderDto, fileDto } from '../lib/serialize.js';

export const MAX_DEPTH = 64;
const FOLDER_PAGE_CAP = 1000;

type Owner = { userId: Types.ObjectId; userIdStr: string };

/** Active = owned, not trashed, not being purged. Anything else is invisible (404). */
export const activeFilter = (ownerId: Types.ObjectId) => ({ ownerId, deletedAt: null, purgePending: false });

export async function getActiveFolder(ownerId: Types.ObjectId, folderId: Types.ObjectId) {
  const folder = await Folder.findOne({ _id: folderId, ...activeFilter(ownerId) });
  if (!folder) throw notFound('Folder');
  return folder;
}

/** Resolves a destination folder; null means the root of My Drive. */
export async function resolveDestination(ownerId: Types.ObjectId, folderId: Types.ObjectId | null) {
  if (folderId === null) return null;
  return getActiveFolder(ownerId, folderId);
}

/** Root-first chain of ancestors including the folder itself. */
export async function breadcrumbs(ownerId: Types.ObjectId, folderId: Types.ObjectId) {
  const chain: { id: string; name: string }[] = [];
  let current: Types.ObjectId | null = folderId;
  for (let depth = 0; current && depth <= MAX_DEPTH; depth++) {
    const f = (await Folder.findOne({ _id: current, ownerId }, { name: 1, parentFolderId: 1 }).lean()) as
      | { _id: Types.ObjectId; name: string; parentFolderId: Types.ObjectId | null }
      | null;
    if (!f) break;
    chain.unshift({ id: String(f._id), name: f.name });
    current = f.parentFolderId;
  }
  return chain;
}

async function depthOf(ownerId: Types.ObjectId, folderId: Types.ObjectId | null): Promise<number> {
  let depth = 0;
  let current = folderId;
  while (current) {
    depth++;
    if (depth > MAX_DEPTH + 1) break;
    const f = (await Folder.findOne({ _id: current, ownerId }, { parentFolderId: 1 }).lean()) as { parentFolderId: Types.ObjectId | null } | null;
    current = f?.parentFolderId ?? null;
  }
  return depth;
}

/** All descendant folder ids (breadth-first), optionally restricted to a predicate. */
export async function descendantFolderIds(ownerId: Types.ObjectId, rootId: Types.ObjectId, extra: Record<string, unknown> = {}) {
  const out: Types.ObjectId[] = [];
  let frontier = [rootId];
  for (let level = 0; frontier.length && level <= MAX_DEPTH; level++) {
    const children = await Folder.find({ ownerId, parentFolderId: { $in: frontier }, ...extra }, { _id: 1 }).lean();
    frontier = children.map((c) => c._id as Types.ObjectId);
    out.push(...frontier);
  }
  return out;
}

async function subtreeHeight(ownerId: Types.ObjectId, rootId: Types.ObjectId) {
  let height = 0;
  let frontier = [rootId];
  while (frontier.length && height <= MAX_DEPTH) {
    const children = await Folder.find({ ownerId, parentFolderId: { $in: frontier } }, { _id: 1 }).lean();
    frontier = children.map((c) => c._id as Types.ObjectId);
    if (frontier.length) height++;
  }
  return height;
}

export const folderService = {
  async list(owner: Owner, parentFolderId: Types.ObjectId | null) {
    await resolveDestination(owner.userId, parentFolderId);
    const folders = await Folder.find({ ...activeFilter(owner.userId), parentFolderId }).sort({ nameLower: 1, _id: 1 }).limit(FOLDER_PAGE_CAP).lean();
    return folders.map(folderDto);
  },

  async create(owner: Owner, name: string, parentFolderId: Types.ObjectId | null) {
    return treeLock(owner.userIdStr, async () => {
      await resolveDestination(owner.userId, parentFolderId);
      if ((await depthOf(owner.userId, parentFolderId)) >= MAX_DEPTH) {
        throw new AppError(400, 'VALIDATION_ERROR', `Folders can be nested at most ${MAX_DEPTH} levels deep`);
      }
      const folder = await Folder.create({ ownerId: owner.userId, name, parentFolderId });
      return folderDto(folder.toObject());
    });
  },

  async get(owner: Owner, folderId: Types.ObjectId) {
    const folder = await getActiveFolder(owner.userId, folderId);
    return { ...folderDto(folder.toObject()), path: await breadcrumbs(owner.userId, folderId) };
  },

  /** Lists a folder: all subfolders (first page only) plus a keyset-paginated page of files. */
  async contents(owner: Owner, folderId: Types.ObjectId | null, q: ListQuery) {
    const folder = folderId ? await getActiveFolder(owner.userId, folderId) : null;
    const field = SORT_FIELDS[q.sort];
    const { sort, filter } = keyset(field, q.order, q.cursor);
    const files = await FileModel.find({ ...activeFilter(owner.userId), parentFolderId: folderId, uploadStatus: 'completed', ...filter })
      .sort(sort)
      .limit(q.limit + 1)
      .lean();
    const hasMore = files.length > q.limit;
    const page = files.slice(0, q.limit);
    let folders: ReturnType<typeof folderDto>[] = [];
    if (!q.cursor) {
      const folderSortField = q.sort === 'size' ? 'nameLower' : field;
      const folderOrder = q.sort === 'size' ? 1 : q.order === 'asc' ? 1 : -1;
      const docs = await Folder.find({ ...activeFilter(owner.userId), parentFolderId: folderId })
        .sort({ [folderSortField]: folderOrder, _id: folderOrder })
        .limit(FOLDER_PAGE_CAP)
        .lean();
      folders = docs.map(folderDto);
    }
    const last = page[page.length - 1];
    return {
      folder: folder ? folderDto(folder.toObject()) : null,
      path: folderId ? await breadcrumbs(owner.userId, folderId) : [],
      folders,
      files: page.map(fileDto),
      nextCursor: hasMore && last ? encodeCursor(last as Record<string, unknown>, field) : null,
    };
  },

  async update(owner: Owner, folderId: Types.ObjectId, patch: { name?: string; isStarred?: boolean }) {
    const folder = await Folder.findOneAndUpdate(
      { _id: folderId, ...activeFilter(owner.userId) },
      { $set: { ...patch, ...(patch.name ? { nameLower: patch.name.toLowerCase() } : {}), lastActivityAt: new Date() } },
      { new: true, runValidators: true },
    ).lean();
    if (!folder) throw notFound('Folder');
    return folderDto(folder);
  },

  /**
   * Moves a folder. Rejects moving into itself or any descendant by walking the destination's
   * ancestor chain (under the per-user tree lock, so concurrent moves cannot race into a cycle).
   */
  async move(owner: Owner, folderId: Types.ObjectId, destinationId: Types.ObjectId | null) {
    return treeLock(owner.userIdStr, async () => {
      const folder = await getActiveFolder(owner.userId, folderId);
      if (destinationId && destinationId.equals(folderId)) {
        throw new AppError(400, 'INVALID_MOVE', 'A folder cannot be moved into itself');
      }
      await resolveDestination(owner.userId, destinationId);
      let current = destinationId;
      for (let depth = 0; current; depth++) {
        if (current.equals(folderId)) throw new AppError(400, 'INVALID_MOVE', 'A folder cannot be moved into one of its own subfolders');
        if (depth > MAX_DEPTH) throw new AppError(400, 'INVALID_MOVE', 'Folder hierarchy is too deep');
        const f = (await Folder.findOne({ _id: current, ownerId: owner.userId }, { parentFolderId: 1 }).lean()) as { parentFolderId: Types.ObjectId | null } | null;
        current = f?.parentFolderId ?? null;
      }
      const newDepth = (await depthOf(owner.userId, destinationId)) + 1 + (await subtreeHeight(owner.userId, folderId));
      if (newDepth > MAX_DEPTH) throw new AppError(400, 'INVALID_MOVE', `Folders can be nested at most ${MAX_DEPTH} levels deep`);
      folder.parentFolderId = destinationId;
      folder.lastActivityAt = new Date();
      await folder.save();
      return folderDto(folder.toObject());
    });
  },
};
