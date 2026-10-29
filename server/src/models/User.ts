import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 80 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    passwordHash: { type: String, required: true, select: false },
    // Bytes. Quota is per user and configurable; defaults to MAX_USER_STORAGE_MB.
    storageQuota: { type: Number, required: true, min: 0 },
    // Bytes held by completed files, including files in Trash (see docs/STORAGE_POLICY.md).
    storageUsed: { type: Number, required: true, default: 0, min: 0 },
    // Bytes reserved by uploads that have been initiated but not yet completed or released.
    storageReserved: { type: Number, required: true, default: 0, min: 0 },
    status: { type: String, enum: ['active', 'disabled'], default: 'active', required: true },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model('User', userSchema);
