import type { Request, Response } from 'express';
import { User } from '../models/index.js';
import { body } from '../middleware/validate.js';
import { setSessionCookies, clearSessionCookies, SESSION_COOKIE } from '../middleware/auth.js';
import { authService, csrfFor, hashToken, publicUser } from '../services/auth.service.js';
import { registerSchema, loginSchema, updateProfileSchema, changePasswordSchema } from '../validators/schemas.js';
import { notFound } from '../lib/errors.js';

export const authController = {
  async register(req: Request, res: Response) {
    const input = body(req, registerSchema);
    const { user, session } = await authService.register(input, req.get('user-agent'));
    setSessionCookies(res, session.token, session.csrfToken);
    res.status(201).json({ user: publicUser(user), csrfToken: session.csrfToken });
  },

  async login(req: Request, res: Response) {
    const input = body(req, loginSchema);
    const { user, session } = await authService.login(input, req.get('user-agent'));
    setSessionCookies(res, session.token, session.csrfToken);
    res.json({ user: publicUser(user), csrfToken: session.csrfToken });
  },

  async logout(req: Request, res: Response) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string') await authService.logout(hashToken(token));
    clearSessionCookies(res);
    res.status(204).end();
  },

  async me(req: Request, res: Response) {
    const user = await User.findById(req.auth!.userId).lean();
    if (!user) throw notFound('User');
    res.json({ user: publicUser(user), csrfToken: csrfFor(req.auth!.tokenHash) });
  },

  async updateMe(req: Request, res: Response) {
    const { name } = body(req, updateProfileSchema);
    const user = await User.findByIdAndUpdate(req.auth!.userId, { $set: { name } }, { new: true, runValidators: true }).lean();
    if (!user) throw notFound('User');
    res.json({ user: publicUser(user) });
  },

  async changePassword(req: Request, res: Response) {
    const input = body(req, changePasswordSchema);
    await authService.changePassword(req.auth!.userId, input.currentPassword, input.newPassword, req.auth!.tokenHash);
    res.status(204).end();
  },
};
