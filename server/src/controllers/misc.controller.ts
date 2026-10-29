import type { Request, Response } from 'express';
import { query } from '../middleware/validate.js';
import { toObjectId } from '../lib/ids.js';
import { trashService } from '../services/trash.service.js';
import { searchService } from '../services/search.service.js';
import { storageService } from '../services/storage.service.js';
import { searchQuery, recentQuery } from '../validators/schemas.js';

export const trashController = {
  async list(req: Request, res: Response) {
    res.json(await trashService.list(req.auth!));
  },
  async restore(req: Request, res: Response) {
    res.json(await trashService.restore(req.auth!, toObjectId(req.params.id)));
  },
  async permanentDelete(req: Request, res: Response) {
    res.json(await trashService.permanentDelete(req.auth!, toObjectId(req.params.id)));
  },
  async empty(req: Request, res: Response) {
    res.json(await trashService.empty(req.auth!));
  },
};

export const discoveryController = {
  async search(req: Request, res: Response) {
    res.json(await searchService.search(req.auth!.userId, query(req, searchQuery)));
  },
  async recent(req: Request, res: Response) {
    const q = query(req, recentQuery);
    res.json(await searchService.recent(req.auth!.userId, q.limit, q.cursor));
  },
  async starred(req: Request, res: Response) {
    res.json(await searchService.starred(req.auth!.userId));
  },
  async usage(req: Request, res: Response) {
    res.json(await storageService.usage(req.auth!.userId));
  },
};
