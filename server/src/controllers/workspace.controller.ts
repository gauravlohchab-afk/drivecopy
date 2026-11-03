import type { Request, Response } from 'express';
import { body } from '../middleware/validate.js';
import { toObjectId } from '../lib/ids.js';
import { workspaceService } from '../services/workspace.service.js';
import { createWorkspaceSchema, updateWorkspaceSchema, workspaceItemsSchema } from '../validators/schemas.js';

const id = (req: Request) => toObjectId(req.params.id, 'Workspace');

export const workspaceController = {
  async list(req: Request, res: Response) {
    res.json({ workspaces: await workspaceService.list(req.auth!) });
  },
  async create(req: Request, res: Response) {
    const input = body(req, createWorkspaceSchema);
    res.status(201).json({ workspace: await workspaceService.create(req.auth!, input.name, input.items) });
  },
  async get(req: Request, res: Response) {
    res.json(await workspaceService.get(req.auth!, id(req)));
  },
  async update(req: Request, res: Response) {
    res.json({ workspace: await workspaceService.update(req.auth!, id(req), body(req, updateWorkspaceSchema)) });
  },
  async remove(req: Request, res: Response) {
    res.json(await workspaceService.remove(req.auth!, id(req)));
  },
  async addItems(req: Request, res: Response) {
    const { items } = body(req, workspaceItemsSchema);
    res.json({ workspace: await workspaceService.addItems(req.auth!, id(req), items) });
  },
  async removeItem(req: Request, res: Response) {
    res.json({ workspace: await workspaceService.removeItem(req.auth!, id(req), toObjectId(req.params.itemId, 'Item')) });
  },
};
