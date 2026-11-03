import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { body } from '../middleware/validate.js';
import { toObjectId } from '../lib/ids.js';
import { badRequest } from '../lib/errors.js';
import { DRIVE_ROLES, type DriveRole } from '../models/index.js';
import { driveService } from '../services/drive.service.js';
import { itemName } from '../validators/schemas.js';
import { folderController } from '../controllers/folder.controller.js';
import { fileController } from '../controllers/file.controller.js';
import { uploadController } from '../controllers/upload.controller.js';
import { trashController, discoveryController } from '../controllers/misc.controller.js';

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const role = z.enum(DRIVE_ROLES);
const driveId = (req: Request) => toObjectId(req.params.driveId, 'Shared drive');
const memberId = (req: Request) => toObjectId(req.params.userId, 'Member');

/** Shared drive management: the drive itself and its members. */
export function driveManagementRoutes(r: Router) {
  r.get('/drives', async (req, res) => res.json({ drives: await driveService.list(req.auth!) }));
  r.post('/drives', async (req, res) => {
    const { name } = body(req, z.object({ name: itemName }));
    res.status(201).json({ drive: await driveService.create(req.auth!, name) });
  });
  r.get('/drives/:driveId', async (req, res) => res.json({ drive: await driveService.get(req.auth!, driveId(req)) }));
  r.patch('/drives/:driveId', async (req, res) => {
    const patch = body(req, z.object({ name: itemName.optional(), hidden: z.boolean().optional() }).refine((v) => v.name !== undefined || v.hidden !== undefined, 'Nothing to update'));
    let drive = patch.name !== undefined ? await driveService.rename(req.auth!, driveId(req), patch.name) : null;
    if (patch.hidden !== undefined) drive = await driveService.setHidden(req.auth!, driveId(req), patch.hidden);
    res.json({ drive });
  });
  r.delete('/drives/:driveId', async (req, res) => res.json(await driveService.remove(req.auth!, driveId(req))));
  r.get('/drives/:driveId/members', async (req, res) => res.json({ members: await driveService.members(req.auth!, driveId(req)) }));
  r.post('/drives/:driveId/members', async (req, res) => {
    const input = body(req, z.object({ email, role }));
    res.json({ members: await driveService.addMember(req.auth!, driveId(req), input.email, input.role) });
  });
  r.patch('/drives/:driveId/members/:userId', async (req, res) => {
    const input = body(req, z.object({ role }));
    res.json({ members: await driveService.setRole(req.auth!, driveId(req), memberId(req), input.role) });
  });
  r.delete('/drives/:driveId/members/:userId', async (req, res) => {
    res.json({ members: await driveService.removeMember(req.auth!, driveId(req), memberId(req)) });
  });
}

/** Requests a viewer may make: reads, plus asking for short-lived view/download URLs. */
function neededRole(req: Request): DriveRole {
  if (req.method === 'GET') return 'viewer';
  if (req.method === 'POST' && /\/(preview-url|download-url)$|^\/files\/thumbnail-urls$/.test(req.path)) return 'viewer';
  return 'content_manager';
}

/** Tags every file/folder in a response with the drive it lives in and the caller's role. */
function stamp(value: unknown, tag: { driveId: string; driveRole: DriveRole }): unknown {
  if (Array.isArray(value)) return value.map((v) => stamp(v, tag));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = stamp(v, tag);
    if ((o.kind === 'file' || o.kind === 'folder') && typeof o.id === 'string') Object.assign(out, tag);
    return out;
  }
  return value;
}

/**
 * Everything inside a shared drive reuses the regular file/folder/upload/trash handlers, run as
 * the drive's owning principal once the caller's membership and role are checked. Activity still
 * records the real member as the actor.
 */
export function driveContentRouter() {
  const r = Router({ mergeParams: true });
  r.use(async (req: Request, res: Response, next: NextFunction) => {
    const user = req.auth!;
    const id = driveId(req);
    const { role, principal } = await driveService.enter(user, id, neededRole(req));
    // Stars are personal, but drive items are shared by every member, so they can't be starred.
    if (/\/star$/.test(req.path) || (req.method === 'PATCH' && req.body && 'isStarred' in req.body)) {
      throw badRequest('Items in shared drives can’t be starred');
    }
    req.auth = { ...principal, tokenHash: user.tokenHash, actorId: user.userId };
    const tag = { driveId: String(id), driveRole: role };
    const json = res.json.bind(res);
    res.json = (payload: unknown) => json(stamp(payload, tag));
    next();
  });

  r.get('/storage/usage', discoveryController.usage);
  r.get('/search', discoveryController.search);

  r.get('/folders', folderController.list);
  r.post('/folders', folderController.create);
  r.get('/folders/:id', folderController.get);
  r.get('/folders/:id/contents', folderController.contents);
  r.patch('/folders/:id', folderController.update);
  r.post('/folders/:id/move', folderController.move);
  r.delete('/folders/:id', folderController.trash);

  r.get('/files', fileController.list);
  r.post('/files/thumbnail-urls', fileController.thumbnails);
  r.get('/files/:id', fileController.get);
  r.patch('/files/:id', fileController.update);
  r.post('/files/:id/move', fileController.move);
  r.post('/files/:id/preview-url', fileController.previewUrl);
  r.post('/files/:id/download-url', fileController.downloadUrl);
  r.delete('/files/:id', fileController.trash);

  r.get('/uploads/policy', uploadController.policy);
  r.post('/uploads/initiate', uploadController.initiate);
  r.get('/uploads/:id', uploadController.get);
  r.post('/uploads/:id/url', uploadController.refreshUrl);
  r.post('/uploads/:id/complete', uploadController.complete);
  r.post('/uploads/:id/cancel', uploadController.cancel);
  r.post('/uploads/:id/multipart/part-url', uploadController.partUrls);
  r.post('/uploads/:id/multipart/complete', uploadController.completeMultipart);
  r.post('/uploads/:id/multipart/abort', uploadController.abortMultipart);

  r.get('/trash', trashController.list);
  r.delete('/trash', trashController.empty);
  r.post('/trash/:id/restore', trashController.restore);
  r.delete('/trash/:id/permanent', trashController.permanentDelete);
  return r;
}
