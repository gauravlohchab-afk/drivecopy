import type { Types } from 'mongoose';
import { Folder, FileModel, Share, User } from '../models/index.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { folderDto, fileDto } from '../lib/serialize.js';
import type { ListQuery } from '../lib/pagination.js';
import { MAX_DEPTH, activeFilter, descendantFolderIds, folderService } from './folder.service.js';
import { activityService } from './activity.service.js';

type Owner = { userId: Types.ObjectId; userIdStr: string; actorId?: Types.ObjectId };
export type ShareKind = 'file' | 'folder';

const MAX_SHARES_PER_ITEM = 100;
const SHARED_LIST_CAP = 1000;

/** Not in Trash and not being purged, whoever owns it. */
const alive = { deletedAt: null, purgePending: false };
const label = (kind: ShareKind) => (kind === 'folder' ? 'Folder' : 'File');

async function getOwnedItem(owner: Owner, kind: ShareKind, id: Types.ObjectId) {
  const q = { _id: id, ...activeFilter(owner.userId) };
  const projection = { name: 1, ownerId: 1 };
  const doc = kind === 'folder' ? await Folder.findOne(q, projection).lean() : await FileModel.findOne({ ...q, uploadStatus: 'completed' }, projection).lean();
  if (!doc) throw notFound(label(kind));
  return doc;
}

/** Folder ids from `folderId` up to the root of the owner's tree, nearest first. */
async function ancestors(ownerId: Types.ObjectId, folderId: Types.ObjectId | null) {
  const chain: Types.ObjectId[] = [];
  let current = folderId;
  for (let depth = 0; current && depth <= MAX_DEPTH; depth++) {
    chain.push(current);
    const f = (await Folder.findOne({ _id: current, ownerId }, { parentFolderId: 1 }).lean()) as { parentFolderId: Types.ObjectId | null } | null;
    current = f?.parentFolderId ?? null;
  }
  return chain;
}

/**
 * Whether `viewerId` was given the item, directly or through a shared ancestor folder. Returns the
 * ids (the item, then its ancestors) from the item up to the highest shared one: the part of the
 * owner's tree the viewer may see.
 */
async function grantedChain(viewerId: Types.ObjectId, ownerId: Types.ObjectId, itemId: Types.ObjectId, parentId: Types.ObjectId | null) {
  const chain = [itemId, ...(await ancestors(ownerId, parentId))];
  const grants = await Share.find({ granteeId: viewerId, ownerId, itemId: { $in: chain } }, { itemId: 1 }).lean();
  if (!grants.length) return null;
  const granted = new Set(grants.map((g) => String(g.itemId)));
  let top = 0;
  chain.forEach((id, i) => {
    if (granted.has(String(id))) top = i;
  });
  return chain.slice(0, top + 1);
}

/** Owner access, or the visible part of the owner's tree for a viewer; 404 otherwise. */
async function access(user: Owner, doc: { _id: Types.ObjectId; ownerId: Types.ObjectId; parentFolderId?: Types.ObjectId | null }, kind: ShareKind) {
  if (doc.ownerId.equals(user.userId)) return { owned: true as const, visible: null };
  const visible = await grantedChain(user.userId, doc.ownerId, doc._id, doc.parentFolderId ?? null);
  if (!visible) throw notFound(label(kind));
  return { owned: false as const, visible };
}

type Person = { name: string; email: string };

async function people(ids: Types.ObjectId[]) {
  const users = await User.find({ _id: { $in: ids } }, { name: 1, email: 1 }).lean();
  return new Map(users.map((u) => [String(u._id), { name: u.name, email: u.email } as Person]));
}

/** Viewers don't see the owner's stars or where the item sits in the owner's tree. */
function forViewer<T extends { isStarred: boolean; parentFolderId: string | null }>(dto: T, owner?: Person) {
  return { ...dto, isStarred: false, parentFolderId: null, ...(owner ? { owner } : {}) };
}

export const shareService = {
  /** Owner only: who the item is shared with. */
  async list(owner: Owner, kind: ShareKind, id: Types.ObjectId) {
    await getOwnedItem(owner, kind, id);
    const shares = await Share.find({ itemId: id, ownerId: owner.userId }).sort({ createdAt: 1 }).lean();
    const byId = await people(shares.map((s) => s.granteeId));
    return shares.flatMap((s) => {
      const p = byId.get(String(s.granteeId));
      return p ? [{ userId: String(s.granteeId), ...p, sharedAt: s.createdAt.toISOString() }] : [];
    });
  },

  async add(owner: Owner, kind: ShareKind, id: Types.ObjectId, email: string) {
    const item = await getOwnedItem(owner, kind, id);
    const grantee = await User.findOne({ email, status: 'active', kind: { $ne: 'drive' } }, { _id: 1 }).lean();
    if (!grantee) throw new AppError(404, 'NOT_FOUND', 'No Cirrus account uses that email address');
    if (grantee._id.equals(owner.userId)) throw badRequest('You already own this item');
    const exists = await Share.exists({ itemId: id, granteeId: grantee._id });
    if (!exists && (await Share.countDocuments({ itemId: id })) >= MAX_SHARES_PER_ITEM) {
      throw badRequest(`An item can be shared with at most ${MAX_SHARES_PER_ITEM} people`);
    }
    await Share.updateOne(
      { itemId: id, granteeId: grantee._id },
      { $setOnInsert: { kind, ownerId: owner.userId } },
      { upsert: true },
    );
    if (!exists) await activityService.record({ actorId: owner.actorId ?? owner.userId, action: 'share', kind, item, targetUserId: grantee._id });
    return this.list(owner, kind, id);
  },

  async remove(owner: Owner, kind: ShareKind, id: Types.ObjectId, granteeId: Types.ObjectId) {
    const item = await getOwnedItem(owner, kind, id);
    const res = await Share.deleteOne({ itemId: id, ownerId: owner.userId, granteeId });
    if (res.deletedCount) await activityService.record({ actorId: owner.actorId ?? owner.userId, action: 'unshare', kind, item, targetUserId: granteeId });
    return this.list(owner, kind, id);
  },

  /** A viewer takes an item off their "Shared with me" list. */
  async leave(viewer: Owner, itemId: Types.ObjectId) {
    const res = await Share.deleteOne({ itemId, granteeId: viewer.userId });
    if (!res.deletedCount) throw notFound('Shared item');
    return { removed: true };
  },

  /** Items shared directly with the viewer, newest share first. Trashed items are left out. */
  async sharedWithMe(viewer: Owner) {
    const shares = await Share.find({ granteeId: viewer.userId }).sort({ createdAt: -1 }).limit(SHARED_LIST_CAP).lean();
    const ids = (kind: ShareKind) => shares.filter((s) => s.kind === kind).map((s) => s.itemId);
    const [folders, files, byOwner] = await Promise.all([
      Folder.find({ _id: { $in: ids('folder') }, ...alive }).lean(),
      FileModel.find({ _id: { $in: ids('file') }, ...alive, uploadStatus: 'completed' }).lean(),
      people(shares.map((s) => s.ownerId)),
    ]);
    const sharedAt = new Map(shares.map((s) => [String(s.itemId), s.createdAt.toISOString()]));
    const order = (a: { _id: unknown }, b: { _id: unknown }) => (sharedAt.get(String(b._id)) ?? '').localeCompare(sharedAt.get(String(a._id)) ?? '');
    const decorate = <T extends { id: string; isStarred: boolean; parentFolderId: string | null }>(dto: T, ownerId: unknown) => ({
      ...forViewer(dto, byOwner.get(String(ownerId))),
      sharedAt: sharedAt.get(dto.id)!,
    });
    return {
      folders: folders.sort(order).map((f) => decorate(folderDto(f), f.ownerId)),
      files: files.sort(order).map((f) => decorate(fileDto(f), f.ownerId)),
    };
  },

  /**
   * A file the user may read: their own, or one shared with them directly or through a folder.
   * Anything else is a 404, exactly like a missing file.
   */
  async readableFile(user: Owner, id: Types.ObjectId) {
    const doc = await FileModel.findOne({ _id: id, ...alive, uploadStatus: 'completed' }).lean();
    if (!doc) throw notFound('File');
    return { doc, ...(await access(user, doc, 'file')) };
  },

  async readableFolder(user: Owner, id: Types.ObjectId) {
    const doc = await Folder.findOne({ _id: id, ...alive }).lean();
    if (!doc) throw notFound('Folder');
    return { doc, ...(await access(user, doc, 'folder')) };
  },

  /**
   * The item as this user should see it (their own, or a viewer copy carrying the owner), or null
   * if it is gone or they can't read it.
   */
  /**
   * What a search may reach among things shared with the viewer: the directly shared items, and
   * every folder inside shared folders (as the owner's tree is now).
   */
  async searchScope(viewer: Owner) {
    const shares = await Share.find({ granteeId: viewer.userId }, { itemId: 1, kind: 1, ownerId: 1 }).limit(SHARED_LIST_CAP).lean();
    const folderTreeIds: Types.ObjectId[] = [];
    for (const s of shares.filter((x) => x.kind === 'folder')) {
      folderTreeIds.push(s.itemId, ...(await descendantFolderIds(s.ownerId, s.itemId, alive)));
      if (folderTreeIds.length > 20_000) break;
    }
    return { directIds: shares.map((s) => s.itemId), folderTreeIds };
  },

  /** Viewer copies (owner attached, owner-only fields cleared) of other people's items. */
  async viewerDtos<K extends ShareKind>(kind: K, docs: (Record<string, unknown> & { _id: unknown; ownerId: Types.ObjectId })[]) {
    const byId = await people(docs.map((d) => d.ownerId));
    return docs.map((d) => {
      const dto = kind === 'file' ? fileDto(d) : folderDto(d);
      return forViewer(dto, byId.get(String(d.ownerId)));
    }) as K extends 'file' ? ReturnType<typeof fileDto>[] : ReturnType<typeof folderDto>[];
  },

  async view(user: Owner, kind: ShareKind, id: Types.ObjectId) {
    const found = await (kind === 'file' ? this.readableFile(user, id) : this.readableFolder(user, id)).catch(() => null);
    if (!found) return null;
    const dto = kind === 'file' ? fileDto(found.doc as Parameters<typeof fileDto>[0]) : folderDto(found.doc);
    if (found.owned) return dto;
    return forViewer(dto, (await people([found.doc.ownerId])).get(String(found.doc.ownerId)));
  },

  /** Read-only listing of a shared folder, with the breadcrumb trimmed to the shared part. */
  async folderContents(viewer: Owner, folderId: Types.ObjectId, q: ListQuery) {
    const { doc, visible } = await this.readableFolder(viewer, folderId);
    const owner = { userId: doc.ownerId, userIdStr: String(doc.ownerId) };
    const res = await folderService.contents(owner, folderId, q);
    const allowed = visible ? new Set(visible.map(String)) : null;
    const ownerPerson = (await people([doc.ownerId])).get(String(doc.ownerId));
    return {
      ...res,
      folder: res.folder && forViewer(res.folder, ownerPerson),
      path: allowed ? res.path.filter((c) => allowed.has(c.id)) : res.path,
      folders: res.folders.map((f) => forViewer(f, ownerPerson)),
      files: res.files.map((f) => forViewer(f, ownerPerson)),
    };
  },
};
