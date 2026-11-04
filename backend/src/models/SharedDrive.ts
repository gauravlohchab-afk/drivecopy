import { Schema, model, Types, type InferSchemaType, type HydratedDocument } from 'mongoose';

export const DRIVE_ROLES = ['viewer', 'content_manager', 'manager'] as const;
export type DriveRole = (typeof DRIVE_ROLES)[number];

/**
 * A team-owned space. Its files and folders are owned by `principalId`, a non-login account of
 * kind "drive" that also carries the drive's storage counters, so all existing ownership rules,
 * Trash and usage accounting apply unchanged. Members act on the drive through their role.
 */
const sharedDriveSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 255 },
    principalId: { type: Types.ObjectId, ref: 'User', required: true },
    createdBy: { type: Types.ObjectId, ref: 'User', required: true },
    members: {
      type: [
        new Schema(
          {
            userId: { type: Types.ObjectId, ref: 'User', required: true },
            role: { type: String, enum: DRIVE_ROLES, required: true },
            // Per member: "Hidden shared drives".
            hidden: { type: Boolean, default: false },
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

sharedDriveSchema.index({ 'members.userId': 1 });
sharedDriveSchema.index({ principalId: 1 }, { unique: true });

export type SharedDriveDoc = HydratedDocument<InferSchemaType<typeof sharedDriveSchema>>;
export const SharedDrive = model('SharedDrive', sharedDriveSchema);
