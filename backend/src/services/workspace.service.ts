import type { Types } from 'mongoose';
import { Workspace } from '../models/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { shareService, type ShareKind } from './share.service.js';

type Owner = { userId: Types.ObjectId; userIdStr: string };
type ItemRef = { id: Types.ObjectId; kind: ShareKind };

export const MAX_ITEMS_PER_WORKSPACE = 25;
const MAX_WORKSPACES = 100;

type WorkspaceLean = { _id: unknown; name: string; hidden?: boolean; items: { itemId: Types.ObjectId; kind: string }[]; createdAt: Date; updatedAt: Date };

function summary(w: WorkspaceLean) {
  return {
    id: String(w._id),
    name: w.name,
    hidden: Boolean(w.hidden),
    itemCount: w.items.length,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

async function getOwned(owner: Owner, id: Types.ObjectId) {
  const w = await Workspace.findOne({ _id: id, ownerId: owner.userId });
  if (!w) throw notFound('Workspace');
  return w;
}

/** Every item must be one the user can currently read (their own, or shared with them). */
async function assertReadable(owner: Owner, items: ItemRef[]) {
  for (const it of items) {
    if (!(await shareService.view(owner, it.kind, it.id))) throw notFound(it.kind === 'folder' ? 'Folder' : 'File');
  }
}

function addRefs(w: { items: { itemId: Types.ObjectId; kind: string }[] }, items: ItemRef[]) {
  const have = new Set(w.items.map((i) => String(i.itemId)));
  const fresh = items.filter((i, idx) => !have.has(String(i.id)) && items.findIndex((j) => String(j.id) === String(i.id)) === idx);
  if (w.items.length + fresh.length > MAX_ITEMS_PER_WORKSPACE) {
    throw badRequest(`A workspace can hold up to ${MAX_ITEMS_PER_WORKSPACE} files and folders`);
  }
  return fresh.map((i) => ({ itemId: i.id, kind: i.kind, addedAt: new Date() }));
}

export const workspaceService = {
  async list(owner: Owner) {
    const docs = await Workspace.find({ ownerId: owner.userId }).sort({ updatedAt: -1, _id: -1 }).lean();
    return docs.map(summary);
  },

  async create(owner: Owner, name: string, items: ItemRef[]) {
    if ((await Workspace.countDocuments({ ownerId: owner.userId })) >= MAX_WORKSPACES) {
      throw badRequest(`You can have up to ${MAX_WORKSPACES} workspaces`);
    }
    await assertReadable(owner, items);
    const refs = addRefs({ items: [] }, items);
    const w = await Workspace.create({ ownerId: owner.userId, name, items: refs });
    return summary(w.toObject());
  },

  async update(owner: Owner, id: Types.ObjectId, patch: { name?: string; hidden?: boolean }) {
    const w = await Workspace.findOneAndUpdate({ _id: id, ownerId: owner.userId }, { $set: patch }, { new: true, runValidators: true }).lean();
    if (!w) throw notFound('Workspace');
    return summary(w);
  },

  async remove(owner: Owner, id: Types.ObjectId) {
    const res = await Workspace.deleteOne({ _id: id, ownerId: owner.userId });
    if (!res.deletedCount) throw notFound('Workspace');
    return { deleted: true };
  },

  async addItems(owner: Owner, id: Types.ObjectId, items: ItemRef[]) {
    const w = await getOwned(owner, id);
    await assertReadable(owner, items);
    const refs = addRefs(w, items);
    if (refs.length) {
      // Guard on the current size so concurrent adds can't push a workspace past the limit.
      const res = await Workspace.updateOne(
        { _id: id, ownerId: owner.userId, [`items.${MAX_ITEMS_PER_WORKSPACE - refs.length}`]: { $exists: false } },
        { $push: { items: { $each: refs } } },
      );
      if (!res.modifiedCount) throw badRequest(`A workspace can hold up to ${MAX_ITEMS_PER_WORKSPACE} files and folders`);
    }
    return summary((await Workspace.findById(id).lean())!);
  },

  async removeItem(owner: Owner, id: Types.ObjectId, itemId: Types.ObjectId) {
    const w = await Workspace.findOneAndUpdate({ _id: id, ownerId: owner.userId }, { $pull: { items: { itemId } } }, { new: true }).lean();
    if (!w) throw notFound('Workspace');
    return summary(w);
  },

  /**
   * Opens a workspace. Items are resolved with the same access rules as everywhere else, so
   * anything trashed, deleted or no longer shared simply doesn't show.
   */
  async get(owner: Owner, id: Types.ObjectId) {
    const w = await getOwned(owner, id);
    const resolved = await Promise.all(w.items.map((i) => shareService.view(owner, i.kind as ShareKind, i.itemId)));
    const visible = resolved.filter((v): v is NonNullable<typeof v> => v !== null);
    return {
      workspace: summary(w.toObject()),
      // References kept for items that are in Trash or no longer shared; they come back if restored.
      unavailable: w.items.length - visible.length,
      folders: visible.filter((v) => v.kind === 'folder'),
      files: visible.filter((v) => v.kind === 'file'),
    };
  },
};
