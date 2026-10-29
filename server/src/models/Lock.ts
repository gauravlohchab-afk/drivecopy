import { Schema, model } from 'mongoose';

// Short-lived mutual exclusion records (e.g. one folder-tree mutation per user at a time).
const lockSchema = new Schema({
  _id: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
lockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Lock = model('Lock', lockSchema);
