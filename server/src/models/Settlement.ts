import { Schema, model, Types } from 'mongoose';

// Exactly-once marker for an upload's quota reservation. The unique _id (the upload session id)
// makes "settle" a single atomic insert: a second attempt fails with a duplicate-key error.
const settlementSchema = new Schema(
  {
    _id: { type: Types.ObjectId, required: true },
    ownerId: { type: Types.ObjectId, required: true },
    outcome: { type: String, enum: ['committed', 'released'], required: true },
    bytes: { type: Number, required: true },
  },
  { timestamps: true },
);

export const Settlement = model('Settlement', settlementSchema);
