import { Types } from 'mongoose';
import { Activity, User, type ActivityAction } from '../models/index.js';
import { keyset, encodeCursor } from '../lib/pagination.js';
import { SharedDrive } from '../models/index.js';
import { logger } from '../lib/logger.js';

type Item = { _id: unknown; ownerId: unknown; name: string };

export interface ActivityEvent {
  actorId: Types.ObjectId;
  action: ActivityAction;
  kind: 'file' | 'folder';
  item: Item;
  detail?: string | null;
  targetUserId?: Types.ObjectId | null;
}

export const activityService = {
  /**
   * Records an event. Logging must never fail the operation it describes, so errors are logged and
   * swallowed.
   */
  async record(e: ActivityEvent) {
    try {
      await Activity.create({
        actorId: e.actorId,
        ownerId: new Types.ObjectId(String(e.item.ownerId)),
        targetUserId: e.targetUserId ?? null,
        action: e.action,
        itemId: new Types.ObjectId(String(e.item._id)),
        itemKind: e.kind,
        itemName: e.item.name,
        detail: e.detail ?? null,
      });
    } catch (err) {
      logger.warn({ err, action: e.action }, 'Could not record activity');
    }
  },

  async recordMany(events: ActivityEvent[]) {
    await Promise.all(events.map((e) => this.record(e)));
  },

  /** Newest first: things the user did, things done to their items, and things shared with them. */
  async feed(userId: Types.ObjectId, limit: number, cursor?: string) {
    const { sort, filter } = keyset('createdAt', 'desc', cursor);
    const drives = await SharedDrive.find({ 'members.userId': userId }, { principalId: 1 }).lean();
    const owners = [userId, ...drives.map((d) => d.principalId)];
    const docs = await Activity.find({ $and: [{ $or: [{ actorId: userId }, { ownerId: { $in: owners } }, { targetUserId: userId }] }, filter] })
      .sort(sort)
      .limit(limit + 1)
      .lean();
    const page = docs.slice(0, limit);
    const ids = new Set<string>();
    for (const d of page) for (const id of [d.actorId, d.ownerId, d.targetUserId]) if (id) ids.add(String(id));
    const users = await User.find({ _id: { $in: [...ids].map((id) => new Types.ObjectId(id)) } }, { name: 1 }).lean();
    const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
    const person = (id: unknown) => (id ? { id: String(id), name: nameOf.get(String(id)) ?? 'Deleted user', isYou: String(id) === String(userId) } : null);
    const last = page[page.length - 1];
    return {
      items: page.map((d) => ({
        id: String(d._id),
        action: d.action,
        at: d.createdAt.toISOString(),
        actor: person(d.actorId)!,
        owner: person(d.ownerId)!,
        target: person(d.targetUserId),
        item: { id: String(d.itemId), kind: d.itemKind, name: d.itemName },
        detail: d.detail ?? null,
      })),
      nextCursor: page.length === limit && docs.length > limit && last ? encodeCursor(last as Record<string, unknown>, 'createdAt') : null,
    };
  },
};
