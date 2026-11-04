import { Schema, model, Types, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * A personal collection of references to files and folders the user is working on. Items stay where
 * they are; a workspace only points at them, and access is re-checked whenever it is opened.
 */
const workspaceSchema = new Schema(
  {
    ownerId: { type: Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 255 },
    hidden: { type: Boolean, default: false },
    items: {
      type: [
        new Schema(
          {
            itemId: { type: Types.ObjectId, required: true },
            kind: { type: String, enum: ['file', 'folder'], required: true },
            addedAt: { type: Date, default: () => new Date() },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

workspaceSchema.index({ ownerId: 1, updatedAt: -1 });

export type WorkspaceDoc = HydratedDocument<InferSchemaType<typeof workspaceSchema>>;
export const Workspace = model('Workspace', workspaceSchema);
