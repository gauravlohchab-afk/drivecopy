import type { Request, Response } from 'express';
import { body } from '../middleware/validate.js';
import { toObjectId } from '../lib/ids.js';
import { uploadService } from '../services/upload.service.js';
import { initiateUploadSchema, partUrlSchema, completeMultipartSchema } from '../validators/schemas.js';
import { FILE_TYPES } from '../lib/fileTypes.js';
import { env, limits } from '../config/env.js';

const id = (req: Request) => toObjectId(req.params.id, 'Upload');

export const uploadController = {
  policy(_req: Request, res: Response) {
    res.json({
      maxFileSize: limits.maxFileSize,
      multipartThreshold: limits.multipartThreshold,
      allowedExtensions: Object.keys(FILE_TYPES),
      urlTtlSeconds: env.PRESIGNED_URL_TTL_SECONDS,
    });
  },
  async initiate(req: Request, res: Response) {
    res.status(201).set('Cache-Control', 'no-store').json(await uploadService.initiate(req.auth!, body(req, initiateUploadSchema)));
  },
  async get(req: Request, res: Response) {
    res.json(await uploadService.get(req.auth!, id(req)));
  },
  async refreshUrl(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store').json(await uploadService.refreshUrl(req.auth!, id(req)));
  },
  async complete(req: Request, res: Response) {
    res.json(await uploadService.complete(req.auth!, id(req)));
  },
  async cancel(req: Request, res: Response) {
    res.json(await uploadService.cancel(req.auth!, id(req)));
  },
  async partUrls(req: Request, res: Response) {
    const { partNumbers } = body(req, partUrlSchema);
    res.set('Cache-Control', 'no-store').json(await uploadService.partUrls(req.auth!, id(req), partNumbers));
  },
  async completeMultipart(req: Request, res: Response) {
    const { parts } = body(req, completeMultipartSchema);
    res.json(await uploadService.completeMultipart(req.auth!, id(req), parts));
  },
  async abortMultipart(req: Request, res: Response) {
    res.json(await uploadService.abortMultipart(req.auth!, id(req)));
  },
};
