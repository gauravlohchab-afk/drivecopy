import type { Request, Response } from 'express';
import { User } from '../models/index.js';
import { body } from '../middleware/validate.js';
import { setSessionCookies, clearSessionCookies, SESSION_COOKIE } from '../middleware/auth.js';
import { authService, csrfFor, hashToken, publicUser } from '../services/auth.service.js';
import { activityService } from '../services/activity.service.js';
import { loginSchema, updateProfileSchema } from '../validators/schemas.js';
import { AppError, notFound } from '../lib/errors.js';

export const authController = {
  async login(req: Request, res: Response) {
    const input = body(req, loginSchema);
    let result;
    try {
      result = await authService.login(input, req.get('user-agent'));
    } catch (err) {
      // What was typed is never recorded: people do paste passwords into the username box.
      if (err instanceof AppError && err.status === 401) await activityService.recordAuth('login_failed', null, req.ip);
      throw err;
    }
    const { user, session } = result;
    await activityService.recordAuth('login', user._id, req.ip);
    setSessionCookies(res, session.token, session.csrfToken);
    res.json({ user: publicUser(user), csrfToken: session.csrfToken });
  },

  async logout(req: Request, res: Response) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string') {
      const userId = await authService.logout(hashToken(token));
      if (userId) await activityService.recordAuth('logout', userId, req.ip);
    }
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
};
