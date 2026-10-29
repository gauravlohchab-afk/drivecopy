import type { Request, Response, NextFunction, CookieOptions } from 'express';
import type { Types } from 'mongoose';
import { env, isProd } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { authService, csrfFor, safeEqual } from '../services/auth.service.js';

export const SESSION_COOKIE = isProd ? '__Host-dc_session' : 'dc_session';
export const CSRF_COOKIE = isProd ? '__Host-dc_csrf' : 'dc_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface AuthContext {
  userId: Types.ObjectId;
  userIdStr: string;
  tokenHash: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

const baseCookie = (): CookieOptions => ({
  secure: isProd,
  sameSite: 'lax',
  path: '/',
  maxAge: env.SESSION_TTL_HOURS * 3600_000,
});

export function setSessionCookies(res: Response, token: string, csrfToken: string) {
  res.cookie(SESSION_COOKIE, token, { ...baseCookie(), httpOnly: true });
  // Readable by the SPA (double-submit); worthless without the HTTP-only session cookie.
  res.cookie(CSRF_COOKIE, csrfToken, { ...baseCookie(), httpOnly: false });
}

export function clearSessionCookies(res: Response) {
  const { maxAge: _maxAge, ...opts } = baseCookie();
  res.clearCookie(SESSION_COOKIE, { ...opts, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, opts);
}

/** Identity always comes from the server-side session, never from request parameters. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue');
  }
  const resolved = await authService.resolveSession(token);
  if (!resolved) throw new AppError(401, 'UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
  req.auth = { userId: resolved.user._id, userIdStr: String(resolved.user._id), tokenHash: resolved.tokenHash };
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated, state-changing requests:
 * 1. If an Origin header is present it must be the configured frontend origin.
 * 2. Authenticated requests must echo the session-bound CSRF token in X-CSRF-Token.
 * SameSite=Lax cookies are an additional layer, not the only one.
 */
export function originCheck(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && origin !== new URL(env.FRONTEND_URL).origin) {
    throw new AppError(403, 'CSRF_FAILED', 'Request origin not allowed');
  }
  next();
}

export function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const header = req.get(CSRF_HEADER);
  if (!req.auth || !header || !safeEqual(header, csrfFor(req.auth.tokenHash))) {
    throw new AppError(403, 'CSRF_FAILED', 'Security token missing or invalid. Refresh the page and try again.');
  }
  next();
}
