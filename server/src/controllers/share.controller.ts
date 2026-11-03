import type { Request, Response } from 'express';
import { body, query } from '../middleware/validate.js';
import { toObjectId } from '../lib/ids.js';
import { shareService, type ShareKind } from '../services/share.service.js';
import { shareSchema, contentsQuery } from '../validators/schemas.js';

const label = (kind: ShareKind) => (kind === 'folder' ? 'Folder' : 'File');

export const shareController = {
  list: (kind: ShareKind) => async (req: Request, res: Response) => {
    res.json({ people: await shareService.list(req.auth!, kind, toObjectId(req.params.id, label(kind))) });
  },
  add: (kind: ShareKind) => async (req: Request, res: Response) => {
    const { email } = body(req, shareSchema);
    res.json({ people: await shareService.add(req.auth!, kind, toObjectId(req.params.id, label(kind)), email) });
  },
  remove: (kind: ShareKind) => async (req: Request, res: Response) => {
    const id = toObjectId(req.params.id, label(kind));
    res.json({ people: await shareService.remove(req.auth!, kind, id, toObjectId(req.params.userId, 'Person')) });
  },
  async sharedWithMe(req: Request, res: Response) {
    res.json(await shareService.sharedWithMe(req.auth!));
  },
  async folderContents(req: Request, res: Response) {
    res.json(await shareService.folderContents(req.auth!, toObjectId(req.params.id, 'Folder'), query(req, contentsQuery)));
  },
  async leave(req: Request, res: Response) {
    res.json(await shareService.leave(req.auth!, toObjectId(req.params.id, 'Shared item')));
  },
};
