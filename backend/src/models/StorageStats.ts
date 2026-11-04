import { Schema, model } from 'mongoose';

/** Cached S3 usage, so page loads never list the bucket. One document, with _id "s3". */
const storageStatsSchema = new Schema(
  {
    _id: { type: String, required: true },
    totalBytes: { type: Number, required: true, default: 0 },
    totalFiles: { type: Number, required: true, default: 0 },
    // Bumped by every upload or delete, so a scan can tell if its result is already out of date.
    revision: { type: Number, required: true, default: 0 },
    // When a full listing of the bucket last confirmed these figures.
    lastVerifiedAt: { type: Date, default: null },
    // When the figures last changed, by a listing or by an upload or delete.
    lastUpdatedAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
  },
  { versionKey: false },
);

export const StorageStats = model('StorageStats', storageStatsSchema);
