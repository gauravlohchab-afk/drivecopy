import { Schema, model, Types, type InferSchemaType, type HydratedDocument } from 'mongoose';

export const UPLOAD_STATUSES = ['pending', 'uploading', 'verifying', 'completed', 'failed', 'cancelled'] as const;
export const FILE_CATEGORIES = ['image', 'video', 'audio', 'pdf', 'document', 'spreadsheet', 'presentation', 'text', 'archive', 'other'] as const;

const fileSchema = new Schema(
  {
    ownerId: { type: Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 255 },
    nameLower: { type: String, required: true },
    // Name as supplied at upload time (sanitised). Never used for S3 keys.
    originalName: { type: String, required: true, maxlength: 255 },
    extension: { type: String, default: '' },
    // Server-derived from the extension allow-list, never taken from the browser as-is.
    mimeType: { type: String, required: true },
    category: { type: String, enum: FILE_CATEGORIES, required: true },
    size: { type: Number, required: true, min: 0 },
    // Server-generated key: users/<ownerId>/<random uuid>. Unique per object.
    s3Key: { type: String, required: true },
    etag: { type: String },
    parentFolderId: { type: Types.ObjectId, ref: 'Folder', default: null },
    uploadId: { type: Types.ObjectId, ref: 'UploadSession', required: true },
    uploadStatus: { type: String, enum: UPLOAD_STATUSES, required: true, default: 'pending' },
    isStarred: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    trashRootId: { type: Types.ObjectId, default: null },
    purgePending: { type: Boolean, default: false },
    lastActivityAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

fileSchema.pre('validate', function () {
  if (typeof this.name === 'string') this.nameLower = this.name.toLowerCase();
});

fileSchema.index({ s3Key: 1 }, { unique: true });
// One file record per upload session: retried completions can never create duplicates.
fileSchema.index({ uploadId: 1 }, { unique: true });
fileSchema.index({ ownerId: 1, parentFolderId: 1, deletedAt: 1, uploadStatus: 1 });
fileSchema.index({ ownerId: 1, trashRootId: 1 });
fileSchema.index({ ownerId: 1, isStarred: 1, deletedAt: 1 });
fileSchema.index({ ownerId: 1, lastActivityAt: -1 });
fileSchema.index({ ownerId: 1, nameLower: 1 });
fileSchema.index({ ownerId: 1, category: 1 });
fileSchema.index({ uploadStatus: 1, updatedAt: 1 });
fileSchema.index({ purgePending: 1 });

export type FileDoc = HydratedDocument<InferSchemaType<typeof fileSchema>>;
export const FileModel = model('File', fileSchema);
