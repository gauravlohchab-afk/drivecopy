import { Router } from 'express';
import { requireAdmin, requireAuth, requireCsrf } from '../middleware/auth.js';
import { authLimiter, shareLimiter } from '../middleware/rateLimit.js';
import { authController } from '../controllers/auth.controller.js';
import { folderController } from '../controllers/folder.controller.js';
import { fileController } from '../controllers/file.controller.js';
import { uploadController } from '../controllers/upload.controller.js';
import { trashController, discoveryController } from '../controllers/misc.controller.js';
import { shareController } from '../controllers/share.controller.js';
import { workspaceController } from '../controllers/workspace.controller.js';
import { driveManagementRoutes, driveContentRouter } from './drives.js';

export function apiRouter() {
  const api = Router();

  // Public auth endpoints (rate limited; protected against cross-site use by the origin check).
  // There is no registration: the only login is the one in the backend environment.
  api.post('/auth/login', authLimiter, authController.login);
  api.post('/auth/logout', authController.logout);

  // Everything below requires a valid session and, for writes, the CSRF token.
  const authed = Router();
  authed.use(requireAuth, requireCsrf);

  authed.get('/auth/me', authController.me);
  authed.patch('/auth/me', authController.updateMe);

  authed.get('/folders', folderController.list);
  authed.post('/folders', folderController.create);
  authed.get('/folders/:id', folderController.get);
  authed.get('/folders/:id/contents', folderController.contents);
  authed.patch('/folders/:id', folderController.update);
  authed.post('/folders/:id/star', folderController.star);
  authed.post('/folders/:id/move', folderController.move);
  authed.delete('/folders/:id', folderController.trash);

  authed.get('/files', fileController.list);
  authed.post('/files/thumbnail-urls', fileController.thumbnails);
  authed.get('/files/:id', fileController.get);
  authed.patch('/files/:id', fileController.update);
  authed.post('/files/:id/move', fileController.move);
  authed.post('/files/:id/preview-url', fileController.previewUrl);
  authed.post('/files/:id/download-url', fileController.downloadUrl);
  authed.post('/files/:id/star', fileController.star);
  authed.delete('/files/:id', fileController.trash);

  authed.get('/uploads/policy', uploadController.policy);
  authed.post('/uploads/initiate', uploadController.initiate);
  authed.get('/uploads/:id', uploadController.get);
  authed.post('/uploads/:id/url', uploadController.refreshUrl);
  authed.post('/uploads/:id/complete', uploadController.complete);
  authed.post('/uploads/:id/cancel', uploadController.cancel);
  authed.post('/uploads/:id/multipart/part-url', uploadController.partUrls);
  authed.post('/uploads/:id/multipart/complete', uploadController.completeMultipart);
  authed.post('/uploads/:id/multipart/abort', uploadController.abortMultipart);

  authed.get('/trash', trashController.list);
  authed.delete('/trash', trashController.empty);
  authed.post('/trash/:id/restore', trashController.restore);
  authed.delete('/trash/:id/permanent', trashController.permanentDelete);

  authed.get('/search', discoveryController.search);
  authed.get('/recent', discoveryController.recent);
  authed.get('/starred', discoveryController.starred);
  authed.get('/storage/usage', discoveryController.usage);
  authed.get('/storage/breakdown', discoveryController.storageBreakdown);
  authed.get('/storage/s3', requireAdmin, discoveryController.s3Stats);
  authed.get('/home', discoveryController.home);
  authed.get('/activity', requireAdmin, discoveryController.activity);

  // Sharing: owners manage who has access; viewers get read-only access to what was shared.
  for (const [path, kind] of [['files', 'file'], ['folders', 'folder']] as const) {
    authed.get(`/${path}/:id/shares`, shareController.list(kind));
    authed.post(`/${path}/:id/shares`, shareLimiter, shareController.add(kind));
    authed.delete(`/${path}/:id/shares/:userId`, shareController.remove(kind));
  }
  authed.get('/shared', shareController.sharedWithMe);
  authed.get('/shared/folders/:id/contents', shareController.folderContents);
  authed.delete('/shared/:id', shareController.leave);

  authed.get('/workspaces', workspaceController.list);
  authed.post('/workspaces', workspaceController.create);
  authed.get('/workspaces/:id', workspaceController.get);
  authed.patch('/workspaces/:id', workspaceController.update);
  authed.delete('/workspaces/:id', workspaceController.remove);
  authed.post('/workspaces/:id/items', workspaceController.addItems);
  authed.delete('/workspaces/:id/items/:itemId', workspaceController.removeItem);

  driveManagementRoutes(authed);
  authed.use('/drives/:driveId', driveContentRouter());

  api.use(authed);
  return api;
}
