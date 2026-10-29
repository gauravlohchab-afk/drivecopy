import { Schema, model, Types, type InferSchemaType, type HydratedDocument } from 'mongoose';

const folderSchema = new Schema(
  {
    ownerId: { type: Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 255 },
    nameLower: { type: String, required: true },
    // null means the folder lives at the root of "My Drive".
    parentFolderId: { type: Types.ObjectId, ref: 'Folder', default: null },
    isStarred: { type: Boolean, default: false },
    // Soft-deletion. deletedAt is set on the trashed item and on every descendant that was
    // trashed with it; trashRootId points at the item the user actually moved to Trash.
    deletedAt: { type: Date, default: null },
    trashRootId: { type: Types.ObjectId, default: null },
    // Set when permanent deletion has started; the purge worker finishes the job.
    purgePending: { type: Boolean, default: false },
    lastActivityAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

folderSchema.pre('validate', function () {
  if (typeof this.name === 'string') this.nameLower = this.name.toLowerCase();
});

folderSchema.index({ ownerId: 1, parentFolderId: 1, deletedAt: 1 });
folderSchema.index({ ownerId: 1, trashRootId: 1 });
folderSchema.index({ ownerId: 1, isStarred: 1, deletedAt: 1 });
folderSchema.index({ ownerId: 1, nameLower: 1 });
folderSchema.index({ purgePending: 1 });

export type FolderDoc = HydratedDocument<InferSchemaType<typeof folderSchema>>;
export const Folder = model('Folder', folderSchema);
