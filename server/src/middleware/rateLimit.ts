import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';

const handler = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' } });

const testing = env.NODE_ENV === 'test';

export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: testing ? 1000 : 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  // Successful logins do not count against the limit; failed attempts do.
  skipSuccessfulRequests: true,
  handler,
});

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: testing ? 100_000 : 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
});
