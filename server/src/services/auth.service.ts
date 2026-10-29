import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Types } from 'mongoose';
import { env, limits } from '../config/env.js';
import { User, Session } from '../models/index.js';
import { AppError } from '../lib/errors.js';

// Argon2id with OWASP-recommended parameters (m=19 MiB, t=2, p=1).
const ARGON_OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
// Verified against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH_PROMISE = hash('not-a-real-password-placeholder', ARGON_OPTS);

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** CSRF token bound to the session (HMAC of the session token hash). */
export const csrfFor = (tokenHash: string) =>
  createHmac('sha256', env.SESSION_SECRET).update(`csrf:${tokenHash}`).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function publicUser(u: { _id: unknown; name: string; email: string; storageQuota: number; storageUsed: number; createdAt?: Date }) {
  return { id: String(u._id), name: u.name, email: u.email, storageQuota: u.storageQuota, storageUsed: u.storageUsed, createdAt: u.createdAt };
}

async function createSession(userId: Types.ObjectId, userAgent?: string) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600_000);
  await Session.create({ tokenHash, userId, expiresAt, userAgent: userAgent?.slice(0, 300) });
  return { token, csrfToken: csrfFor(tokenHash), expiresAt };
}

export const authService = {
  async register(input: { name: string; email: string; password: string }, userAgent?: string) {
    const passwordHash = await hash(input.password, ARGON_OPTS);
    try {
      const user = await User.create({ name: input.name, email: input.email, passwordHash, storageQuota: limits.defaultQuota });
      const session = await createSession(user._id, userAgent);
      return { user, session };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new AppError(409, 'CONFLICT', 'An account with this email already exists');
      throw err;
    }
  },

  async login(input: { email: string; password: string }, userAgent?: string) {
    const user = await User.findOne({ email: input.email.toLowerCase() }).select('+passwordHash');
    const ok = user ? await verify(user.passwordHash, input.password) : (await verify(await DUMMY_HASH_PROMISE, input.password), false);
    if (!user || !ok) throw new AppError(401, 'UNAUTHENTICATED', 'Incorrect email or password');
    if (user.status !== 'active') throw new AppError(403, 'FORBIDDEN', 'This account is disabled');
    const session = await createSession(user._id, userAgent);
    return { user, session };
  },

  async logout(tokenHash: string) {
    await Session.deleteOne({ tokenHash });
  },

  async changePassword(userId: Types.ObjectId, currentPassword: string, newPassword: string, keepTokenHash: string) {
    const user = await User.findById(userId).select('+passwordHash');
    if (!user || !(await verify(user.passwordHash, currentPassword))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Current password is incorrect', { field: 'currentPassword' });
    }
    user.passwordHash = await hash(newPassword, ARGON_OPTS);
    await user.save();
    // Sign out every other session after a password change.
    await Session.deleteMany({ userId: user._id, tokenHash: { $ne: keepTokenHash } });
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
