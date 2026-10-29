import { Schema, model, Types, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { UPLOAD_STATUSES } from './File.js';

const uploadSessionSchema = new Schema(
  {
    ownerId: { type: Types.ObjectId, ref: 'User', required: true },
    fileId: { type: Types.ObjectId, ref: 'File', required: true },
    parentFolderId: { type: Types.ObjectId, ref: 'Folder', default: null },
    s3Key: { type: String, required: true },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    // Size declared at initiation. The quota reservation and the signed Content-Length use it,
    // and the object is only accepted if S3 reports exactly this size.
    expectedSize: { type: Number, required: true, min: 0 },
    multipartUploadId: { type: String, default: null },
    partSize: { type: Number, default: null },
    partCount: { type: Number, default: null },
    status: { type: String, enum: UPLOAD_STATUSES, required: true, default: 'pending' },
    expiresAt: { type: Date, required: true },
    // Quota reservation is settled exactly once: committed to storageUsed or released.
    reservationSettled: { type: Boolean, default: false },
    verification: {
      status: { type: String, enum: ['unverified', 'verified', 'rejected'], default: 'unverified' },
      verifiedAt: { type: Date, default: null },
      actualSize: { type: Number, default: null },
      etag: { type: String, default: null },
      reason: { type: String, default: null },
    },
    failureReason: { type: String, default: null },
    // S3 object cleanup still owed for a failed/cancelled session.
    cleanupPending: { type: Boolean, default: false },
  },
  { timestamps: true },
);

uploadSessionSchema.index({ ownerId: 1, status: 1 });
uploadSessionSchema.index({ status: 1, expiresAt: 1 });
uploadSessionSchema.index({ cleanupPending: 1 });
uploadSessionSchema.index({ s3Key: 1 }, { unique: true });

export type UploadSessionDoc = HydratedDocument<InferSchemaType<typeof uploadSessionSchema>>;
export const UploadSession = model('UploadSession', uploadSessionSchema);
