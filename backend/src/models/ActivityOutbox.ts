import { Schema, model } from 'mongoose';

/**
 * Activity events waiting to be written to S3. Saving here first means an event survives a crash,
 * a restart or an S3 outage: it is only removed once S3 has confirmed the write.
 */
const activityOutboxSchema = new Schema<{ event: object }>(
  {
    event: { type: Schema.Types.Mixed, required: true },
  },
  // Events keep their exact shape, including an empty details object.
  { versionKey: false, minimize: false },
);

export const ActivityOutbox = model('ActivityOutbox', activityOutboxSchema);
