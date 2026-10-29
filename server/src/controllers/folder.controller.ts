import type { Request, Response } from 'express';
import { body, query } from '../middleware/validate.js';
import { toObjectId } from '../lib/ids.js';
import { folderService } from '../services/folder.service.js';
import { trashService } from '../services/trash.service.js';
import { createFolderSchema, updateItemSchema, moveSchema, contentsQuery, starSchema } from '../validators/schemas.js';
import { z } from 'zod';
import { parentRef } from '../validators/schemas.js';

const id = (req: Request) => toObjectId(req.params.id, 'Folder');
/** "root" addresses the top level of My Drive in folder routes. */
const folderParam = (req: Request) => (req.params.id === 'root' ? null : id(req));

export const folderController = {
  async list(req: Request, res: Response) {
    const { parentFolderId } = query(req, z.object({ parentFolderId: parentRef }));
    res.json({ items: await folderService.list(req.auth!, parentFolderId) });
  },
  async create(req: Request, res: Response) {
    const input = body(req, createFolderSchema);
    res.status(201).json({ folder: await folderService.create(req.auth!, input.name, input.parentFolderId) });
  },
  async get(req: Request, res: Response) {
    res.json({ folder: await folderService.get(req.auth!, id(req)) });
  },
  async contents(req: Request, res: Response) {
    res.json(await folderService.contents(req.auth!, folderParam(req), query(req, contentsQuery)));
  },
  async update(req: Request, res: Response) {
    res.json({ folder: await folderService.update(req.auth!, id(req), body(req, updateItemSchema)) });
  },
  async star(req: Request, res: Response) {
    const { starred } = body(req, starSchema);
    res.json({ folder: await folderService.update(req.auth!, id(req), { isStarred: starred }) });
  },
  async move(req: Request, res: Response) {
    const { destinationFolderId } = body(req, moveSchema);
    res.json({ folder: await folderService.move(req.auth!, id(req), destinationFolderId) });
  },
  async trash(req: Request, res: Response) {
    res.json(await trashService.trashFolder(req.auth!, id(req)));
  },
};
