import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);
// Query operators never come from user input: every request body/query is parsed by a zod
// schema into plain strings, numbers, booleans and ObjectIds before it reaches a query.

export async function connectDb(uri = env.MONGODB_URI, opts: { syncIndexes?: boolean } = {}) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  if (opts.syncIndexes !== false) await mongoose.syncIndexes();
  logger.info('Connected to MongoDB');
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
