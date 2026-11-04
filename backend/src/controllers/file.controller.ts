import type { Request, Response } from 'express';
import { body, query } from '../middleware/validate.js';
import { toObjectId } from '../lib/ids.js';
import { fileService } from '../services/file.service.js';
import { trashService } from '../services/trash.service.js';
import { listFilesQuery, updateItemSchema, moveSchema, starSchema, thumbnailSchema } from '../validators/schemas.js';

const id = (req: Request) => toObjectId(req.params.id, 'File');

export const fileController = {
  async list(req: Request, res: Response) {
    const q = query(req, listFilesQuery);
    res.json(await fileService.list(req.auth!, q.folderId, q));
  },
  async get(req: Request, res: Response) {
    res.json({ file: await fileService.get(req.auth!, id(req)) });
  },
  async update(req: Request, res: Response) {
    res.json({ file: await fileService.update(req.auth!, id(req), body(req, updateItemSchema)) });
  },
  async move(req: Request, res: Response) {
    const { destinationFolderId } = body(req, moveSchema);
    res.json({ file: await fileService.move(req.auth!, id(req), destinationFolderId) });
  },
  async star(req: Request, res: Response) {
    const { starred } = body(req, starSchema);
    res.json({ file: await fileService.update(req.auth!, id(req), { isStarred: starred }) });
  },
  async previewUrl(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store').json(await fileService.previewUrl(req.auth!, id(req)));
  },
  async downloadUrl(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store').json(await fileService.downloadUrl(req.auth!, id(req)));
  },
  async thumbnails(req: Request, res: Response) {
    const { ids } = body(req, thumbnailSchema);
    res.set('Cache-Control', 'no-store').json(await fileService.thumbnailUrls(req.auth!, ids));
  },
  async trash(req: Request, res: Response) {
    res.json(await trashService.trashFile(req.auth!, id(req)));
  },
};
