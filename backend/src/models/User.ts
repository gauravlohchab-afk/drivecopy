import { Schema, model, Types, type InferSchemaType, type HydratedDocument } from 'mongoose';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 80 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    passwordHash: { type: String, required: true, select: false },
    // "admin" is the single login, whose credentials come from the backend environment.
    role: { type: String, enum: ['user', 'admin'], default: 'user', required: true },
    // Set on a former account once everything it owned has moved to the admin. Kept for history.
    mergedIntoUserId: { type: Types.ObjectId, ref: 'User', default: null },
    // Bytes held by completed files, including files in Trash (see docs/STORAGE_POLICY.md).
    storageUsed: { type: Number, required: true, default: 0, min: 0 },
    // Bytes reserved by uploads that have been initiated but not yet completed or released.
    storageReserved: { type: Number, required: true, default: 0, min: 0 },
    status: { type: String, enum: ['active', 'disabled'], default: 'active', required: true },
    // "drive": the non-login owner of a shared drive's files (see SharedDrive).
    kind: { type: String, enum: ['person', 'drive'], default: 'person', required: true },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model('User', userSchema);
