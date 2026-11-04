import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Types } from 'mongoose';
import { env } from '../config/env.js';
import { User, Session } from '../models/index.js';
import { AppError } from '../lib/errors.js';

/**
 * Account-wide failed-login protection, on top of the per-IP rate limit in middleware/rateLimit.ts:
 * enough consecutive failures from any mix of addresses pause all logins for a while. Restarting
 * the backend clears it, which is also the way back in if someone deliberately triggers it.
 */
const LOCK_AFTER_FAILURES = 20;
const LOCK_MS = 15 * 60_000;
let consecutiveFailures = 0;
let lockedUntil = 0;

export function resetLoginGuard() {
  consecutiveFailures = 0;
  lockedUntil = 0;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** CSRF token bound to the session (HMAC of the session token hash). */
export const csrfFor = (tokenHash: string) =>
  createHmac('sha256', env.SESSION_SECRET).update(`csrf:${tokenHash}`).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Compares digests, so neither the length nor the content of the secret affects timing. */
const sameSecret = (a: string, b: string) => safeEqual(hashToken(a), hashToken(b));

export function publicUser(u: { _id: unknown; name: string; email: string; storageUsed: number; createdAt?: Date }) {
  return { id: String(u._id), name: u.name, email: u.email, storageUsed: u.storageUsed, createdAt: u.createdAt };
}

export async function createSession(userId: Types.ObjectId, userAgent?: string) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600_000);
  await Session.create({ tokenHash, userId, expiresAt, userAgent: userAgent?.slice(0, 300) });
  return { token, csrfToken: csrfFor(tokenHash), expiresAt };
}

export const authService = {
  /** The only way in: the credentials in the backend environment. */
  async login(input: { username: string; password: string }, userAgent?: string) {
    if (Date.now() < lockedUntil) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many failed sign-in attempts. Please wait a few minutes and try again.');
    }
    // Both are always compared, so timing does not reveal which one was wrong.
    const usernameOk = sameSecret(input.username.trim().toLowerCase(), env.ADMIN_LOGIN_USERNAME);
    const passwordOk = sameSecret(input.password, env.ADMIN_LOGIN_PASSWORD);
    if (!usernameOk || !passwordOk) {
      consecutiveFailures++;
      if (consecutiveFailures >= LOCK_AFTER_FAILURES) {
        lockedUntil = Date.now() + LOCK_MS;
        consecutiveFailures = 0;
      }
      throw new AppError(401, 'UNAUTHENTICATED', 'Incorrect username or password');
    }
    consecutiveFailures = 0;
    const user = await User.findOne({ role: 'admin', status: 'active' });
    if (!user) throw new AppError(503, 'INTERNAL', 'The administrator account is not ready. Restart the backend.');
    const session = await createSession(user._id, userAgent);
    return { user, session };
  },

  /** Returns who was signed out, or null when the session no longer existed. */
  async logout(tokenHash: string) {
    const session = await Session.findOneAndDelete({ tokenHash }).lean();
    return session?.userId ?? null;
  },

  async resolveSession(token: string) {
    const tokenHash = hashToken(token);
    const session = await Session.findOne({ tokenHash, expiresAt: { $gt: new Date() } }).lean();
    if (!session) return null;
    const user = await User.findById(session.userId).lean();
    if (!user || user.status !== 'active') return null;
    return { user, tokenHash };
  },
};
