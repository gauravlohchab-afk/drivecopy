import { Schema, model, Types, type InferSchemaType, type HydratedDocument } from 'mongoose';

export const ACTIVITY_ACTIONS = [
  'upload', 'create_folder', 'rename', 'move', 'trash', 'restore', 'delete', 'share', 'unshare', 'download',
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

/**
 * One thing that happened to a file or folder. The item name is a snapshot, so the feed still reads
 * correctly after renames or deletion. Shown to the actor, the item's owner, and (for shares) the
 * person it was shared with.
 */
const activitySchema = new Schema(
  {
    actorId: { type: Types.ObjectId, ref: 'User', required: true },
    ownerId: { type: Types.ObjectId, ref: 'User', required: true },
    // For share / unshare: the person who gained or lost access.
    targetUserId: { type: Types.ObjectId, ref: 'User', default: null },
    action: { type: String, enum: ACTIVITY_ACTIONS, required: true },
    itemId: { type: Types.ObjectId, required: true },
    itemKind: { type: String, enum: ['file', 'folder'], required: true },
    itemName: { type: String, required: true, maxlength: 255 },
    // Rename: the previous name. Move: the destination folder name ("My Drive" for the root).
    detail: { type: String, default: null, maxlength: 255 },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

activitySchema.index({ actorId: 1, createdAt: -1, _id: -1 });
activitySchema.index({ ownerId: 1, createdAt: -1, _id: -1 });
activitySchema.index({ targetUserId: 1, createdAt: -1, _id: -1 });
// Keep a rolling 180 days of history.
activitySchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

export type ActivityDoc = HydratedDocument<InferSchemaType<typeof activitySchema>>;
export const Activity = model('Activity', activitySchema);
