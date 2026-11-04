import { Schema, model } from 'mongoose';

/** One-time data migrations that have finished, by name. */
const migrationSchema = new Schema(
  {
    _id: { type: String, required: true },
    completedAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

export const Migration = model('Migration', migrationSchema);
