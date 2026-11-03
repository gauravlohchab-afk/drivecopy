import { Schema, model, Types, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Read-only access to a file or folder for another user. A folder share covers everything inside
 * it; access is resolved per request by walking the item's ancestors, so moves, new uploads and
 * Trash are reflected without copying grants around.
 */
const shareSchema = new Schema(
  {
    itemId: { type: Types.ObjectId, required: true },
    kind: { type: String, enum: ['file', 'folder'], required: true },
    ownerId: { type: Types.ObjectId, ref: 'User', required: true },
    granteeId: { type: Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

shareSchema.index({ itemId: 1, granteeId: 1 }, { unique: true });
shareSchema.index({ granteeId: 1, createdAt: -1 });
shareSchema.index({ ownerId: 1, itemId: 1 });

export type ShareDoc = HydratedDocument<InferSchemaType<typeof shareSchema>>;
export const Share = model('Share', shareSchema);
