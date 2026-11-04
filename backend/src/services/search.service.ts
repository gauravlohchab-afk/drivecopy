import type { QueryFilter } from 'mongoose';
import type { Types } from 'mongoose';
import { Folder, FileModel, Share, User } from '../models/index.js';
import { keyset, encodeCursor, escapeRegex, SORT_FIELDS, type ListQuery } from '../lib/pagination.js';
import { folderDto, fileDto } from '../lib/serialize.js';
import { activeFilter, descendantFolderIds, getActiveFolder } from './folder.service.js';
import { shareService } from './share.service.js';
import { driveService } from './drive.service.js';
import type { FileCategory } from '../lib/fileTypes.js';

type Owner = { userId: Types.ObjectId; userIdStr: string };

export interface SearchInput extends ListQuery {
  q?: string;
  folderId?: Types.ObjectId | null;
  type?: 'folder' | FileCategory;
  modifiedAfter?: Date;
  modifiedBefore?: Date;
  /** 'any' (default), 'me', 'others', or an owner's email address. */
  owner?: string;
  location?: 'anywhere' | 'mydrive' | 'shared';
  inTrash?: boolean;
  starred?: boolean;
  /** Only items the user shared with this person. */
  sharedTo?: string;
  sizeMin?: number;
  sizeMax?: number;
}

/** Shared results are not paginated; they are merged into the first page, capped. */
const SHARED_CAP = 200;

type FolderDto = ReturnType<typeof folderDto>;
type FileDto = ReturnType<typeof fileDto>;

/** Sorts merged own + shared results the same way the database sorted each part. */
function bySort<T extends { name: string; updatedAt: string | null }>(sort: ListQuery['sort'], order: ListQuery['order'], size: (t: T) => number) {
  const dir = order === 'asc' ? 1 : -1;
  return (a: T, b: T) => {
    const d = sort === 'name' ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : sort === 'size' ? size(a) - size(b) : (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '');
    return d * dir;
  };
}

export const searchService = {
  /**
   * Searches metadata the user can read: their own items (paginated), plus, on the first page,
   * items shared with them directly or inside shared folders. Every filter is applied on the server.
   */
  async search(user: Owner, input: SearchInput) {
    const me = user.userId;
    let includeOwn = true;
    let includeShared = true;
    let sharedOwnerId: Types.ObjectId | null = null;

    const owner = input.owner ?? 'any';
    if (owner === 'me') includeShared = false;
    else if (owner === 'others') includeOwn = false;
    else if (owner !== 'any') {
      const person = await User.findOne({ email: owner.toLowerCase() }, { _id: 1 }).lean();
      if (!person) return { folders: [], files: [], nextCursor: null };
      if (person._id.equals(me)) includeShared = false;
      else {
        includeOwn = false;
        sharedOwnerId = person._id;
      }
    }
    if (input.location === 'mydrive') includeShared = false;
    if (input.location === 'shared') includeOwn = false;
    // These describe the user's own items only.
    if (input.folderId || input.inTrash || input.starred || input.sharedTo) includeShared = false;

    // Filters common to own and shared items.
    const common: Record<string, unknown> = {};
    if (input.q) common.nameLower = { $regex: escapeRegex(input.q.toLowerCase()) };
    if (input.modifiedAfter || input.modifiedBefore) {
      common.updatedAt = { ...(input.modifiedAfter && { $gte: input.modifiedAfter }), ...(input.modifiedBefore && { $lte: input.modifiedBefore }) };
    }
    const sized = input.sizeMin !== undefined || input.sizeMax !== undefined;
    const fileOnly: Record<string, unknown> = { uploadStatus: 'completed' };
    if (input.type && input.type !== 'folder') fileOnly.category = input.type;
    if (sized) fileOnly.size = { ...(input.sizeMin !== undefined && { $gte: input.sizeMin }), ...(input.sizeMax !== undefined && { $lte: input.sizeMax }) };

    // Folders have no size, so a size filter means files only.
    const wantFolders = (!input.type || input.type === 'folder') && !sized;
    const wantFiles = input.type !== 'folder';
    const field = SORT_FIELDS[input.sort];

    let folders: FolderDto[] = [];
    let files: FileDto[] = [];
    let nextCursor: string | null = null;
    // Set when other sources are merged into the first page, which then needs one combined sort.
    let merged = false;

    if (includeOwn) {
      const base: Record<string, unknown> = input.inTrash
        ? { ownerId: me, deletedAt: { $ne: null }, purgePending: false, ...common }
        : { ...activeFilter(me), ...common };
      if (input.starred) base.isStarred = true;
      if (input.sharedTo) {
        const person = await User.findOne({ email: input.sharedTo.toLowerCase() }, { _id: 1 }).lean();
        const shares = person ? await Share.find({ ownerId: me, granteeId: person._id }, { itemId: 1 }).lean() : [];
        base._id = { $in: shares.map((s) => s.itemId) };
      }
      if (input.folderId) {
        await getActiveFolder(me, input.folderId);
        const scope = await descendantFolderIds(me, input.folderId, { deletedAt: null, purgePending: false });
        base.parentFolderId = { $in: [input.folderId, ...scope] };
      }
      if (wantFolders && !input.cursor) {
        const sortField = input.sort === 'size' ? 'nameLower' : field;
        const docs = await Folder.find(base).sort({ [sortField]: input.order === 'desc' && input.sort !== 'size' ? -1 : 1 }).limit(100).lean();
        folders = docs.map(folderDto);
      }
      if (wantFiles) {
        const { sort, filter } = keyset(field, input.order, input.cursor);
        const fileFilter: QueryFilter<unknown> = { ...base, ...fileOnly, ...filter };
        const docs = await FileModel.find(fileFilter).sort(sort).limit(input.limit + 1).lean();
        const page = docs.slice(0, input.limit);
        const last = page[page.length - 1];
        files = page.map(fileDto);
        nextCursor = docs.length > input.limit && last ? encodeCursor(last as Record<string, unknown>, field) : null;
      }
    }

    if (includeShared && !input.cursor) {
      const scope = await shareService.searchScope(user);
      if (scope.directIds.length) {
        const reach = { $or: [{ _id: { $in: scope.directIds } }, { parentFolderId: { $in: scope.folderTreeIds } }] };
        const shared = { deletedAt: null, purgePending: false, ownerId: sharedOwnerId ?? { $ne: me }, ...reach, ...common };
        const [sf, sfi] = await Promise.all([
          wantFolders ? Folder.find(shared).limit(SHARED_CAP).lean() : [],
          wantFiles ? FileModel.find({ ...shared, ...fileOnly }).limit(SHARED_CAP).lean() : [],
        ]);
        folders = [...folders, ...(await shareService.viewerDtos('folder', sf))];
        files = [...files, ...(await shareService.viewerDtos('file', sfi))];
        merged = true;
      }
    }

    // Shared drives the user belongs to (tagged with the drive and the user's role there).
    const searchDrives = includeOwn && owner === 'any' && input.location !== 'mydrive' && !input.folderId && !input.inTrash && !input.starred && !input.sharedTo;
    if (searchDrives && !input.cursor) {
      const drives = await driveService.memberships(me);
      if (drives.length) {
        const byPrincipal = new Map(drives.map((d) => [String(d.principalId), d]));
        const scope = { ownerId: { $in: drives.map((d) => d.principalId) }, deletedAt: null, purgePending: false, ...common };
        const [df, dfi] = await Promise.all([
          wantFolders ? Folder.find(scope).limit(SHARED_CAP).lean() : [],
          wantFiles ? FileModel.find({ ...scope, ...fileOnly }).limit(SHARED_CAP).lean() : [],
        ]);
        const tag = (ownerId: unknown) => {
          const d = byPrincipal.get(String(ownerId))!;
          return { driveId: d.driveId, driveRole: d.role, driveName: d.name };
        };
        folders = [...folders, ...df.map((d) => ({ ...folderDto(d), ...tag(d.ownerId) }))];
        files = [...files, ...dfi.map((d) => ({ ...fileDto(d), ...tag(d.ownerId) }))];
        merged = true;
      }
    }

    if (merged) {
      folders.sort(bySort<FolderDto>(input.sort === 'size' ? 'name' : input.sort, input.sort === 'size' ? 'asc' : input.order, () => 0));
      files.sort(bySort<FileDto>(input.sort, input.order, (f) => f.size));
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
