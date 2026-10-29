import type { QueryFilter } from 'mongoose';
import type { Types } from 'mongoose';
import { Folder, FileModel } from '../models/index.js';
import { keyset, encodeCursor, escapeRegex, SORT_FIELDS, type ListQuery } from '../lib/pagination.js';
import { folderDto, fileDto } from '../lib/serialize.js';
import { activeFilter, descendantFolderIds, getActiveFolder } from './folder.service.js';
import type { FileCategory } from '../lib/fileTypes.js';

export interface SearchInput extends ListQuery {
  q?: string;
  folderId?: Types.ObjectId | null;
  type?: 'folder' | FileCategory;
  modifiedAfter?: Date;
  modifiedBefore?: Date;
}

/** All searches run against MongoDB metadata, scoped to the authenticated owner. */
export const searchService = {
  async search(ownerId: Types.ObjectId, input: SearchInput) {
    const base: Record<string, unknown> = { ...activeFilter(ownerId) };
    if (input.q) base.nameLower = { $regex: escapeRegex(input.q.toLowerCase()) };
    if (input.modifiedAfter || input.modifiedBefore) {
      base.updatedAt = { ...(input.modifiedAfter && { $gte: input.modifiedAfter }), ...(input.modifiedBefore && { $lte: input.modifiedBefore }) };
    }
    if (input.folderId) {
      await getActiveFolder(ownerId, input.folderId);
      const scope = await descendantFolderIds(ownerId, input.folderId, { deletedAt: null, purgePending: false });
      base.parentFolderId = { $in: [input.folderId, ...scope] };
    }

    const field = SORT_FIELDS[input.sort];
    const wantFolders = !input.type || input.type === 'folder';
    const wantFiles = input.type !== 'folder';

    let folders: ReturnType<typeof folderDto>[] = [];
    if (wantFolders && !input.cursor) {
      const sortField = input.sort === 'size' ? 'nameLower' : field;
      const docs = await Folder.find(base).sort({ [sortField]: input.order === 'desc' && input.sort !== 'size' ? -1 : 1 }).limit(100).lean();
      folders = docs.map(folderDto);
    }

    let files: ReturnType<typeof fileDto>[] = [];
    let nextCursor: string | null = null;
    if (wantFiles) {
      const { sort, filter } = keyset(field, input.order, input.cursor);
      const fileFilter: QueryFilter<unknown> = { ...base, uploadStatus: 'completed', ...(input.type && { category: input.type }), ...filter };
      const docs = await FileModel.find(fileFilter).sort(sort).limit(input.limit + 1).lean();
      const page = docs.slice(0, input.limit);
      const last = page[page.length - 1];
      files = page.map(fileDto);
      nextCursor = docs.length > input.limit && last ? encodeCursor(last as Record<string, unknown>, field) : null;
    }
    return { folders, files, nextCursor };
  },

  async recent(ownerId: Types.ObjectId, limit: number, cursor?: string) {
    const { sort, filter } = keyset('lastActivityAt', 'desc', cursor);
    const docs = await FileModel.find({ ...activeFilter(ownerId), uploadStatus: 'completed', ...filter }).sort(sort).limit(limit + 1).lean();
    const page = docs.slice(0, limit);
    const last = page[page.length - 1];
    return { files: page.map(fileDto), nextCursor: docs.length > limit && last ? encodeCursor(last as Record<string, unknown>, 'lastActivityAt') : null };
  },

  async starred(ownerId: Types.ObjectId) {
    const [folders, files] = await Promise.all([
      Folder.find({ ...activeFilter(ownerId), isStarred: true }).sort({ nameLower: 1 }).limit(1000).lean(),
      FileModel.find({ ...activeFilter(ownerId), uploadStatus: 'completed', isStarred: true }).sort({ nameLower: 1 }).limit(1000).lean(),
    ]);
    return { folders: folders.map(folderDto), files: files.map(fileDto) };
  },
};
