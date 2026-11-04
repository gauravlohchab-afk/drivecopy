import { Types } from 'mongoose';
import { AppError } from './errors.js';

export function toObjectId(value: unknown, what = 'Item'): Types.ObjectId {
  if (typeof value !== 'string' || !Types.ObjectId.isValid(value) || !/^[a-f\d]{24}$/i.test(value)) {
    // Treat malformed ids exactly like ids that belong to someone else: not found.
    throw new AppError(404, 'NOT_FOUND', `${what} not found`);
  }
  return new Types.ObjectId(value);
}
