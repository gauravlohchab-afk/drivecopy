import { z } from 'zod';
import { Types } from 'mongoose';
import { sanitizeName } from '../lib/fileTypes.js';
import { listQuerySchema } from '../lib/pagination.js';
import { FILE_CATEGORIES } from '../models/File.js';

const objectId = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Invalid id')
  .transform((v) => new Types.ObjectId(v));

/** Folder reference where null / "root" means the top of My Drive. */
export const parentRef = z
  .union([z.null(), z.literal('root'), z.string().regex(/^[a-f\d]{24}$/i, 'Invalid folder id')])
  .optional()
  .transform((v) => (v && v !== 'root' ? new Types.ObjectId(v) : null));

export const itemName = z
  .string({ error: 'Name is required' })
  .max(255, 'Name must be at most 255 characters')
  .transform(sanitizeName)
  .pipe(
    z
      .string()
      .min(1, 'Name is required')
      .max(255, 'Name must be at most 255 characters')
      .refine((n) => n !== '.' && n !== '..', 'That name is not allowed'),
  );

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long')
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and numbers');

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  email,
  password,
});
export const loginSchema = z.object({ email, password: z.string().min(1, 'Password is required').max(200) });
export const updateProfileSchema = z.object({ name: z.string().trim().min(1, 'Name is required').max(80) });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password });

export const createFolderSchema = z.object({ name: itemName, parentFolderId: parentRef });
export const updateItemSchema = z
  .object({ name: itemName.optional(), isStarred: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.isStarred !== undefined, 'Nothing to update');
export const moveSchema = z.object({ destinationFolderId: parentRef });
export const starSchema = z.object({ starred: z.boolean() });

export const listFilesQuery = listQuerySchema.extend({ folderId: parentRef });
export const contentsQuery = listQuerySchema;

export const initiateUploadSchema = z.object({
  name: z.string().min(1).max(1024),
  size: z.number().int('Size must be a whole number of bytes').min(0),
  mimeType: z.string().max(255).optional(),
  parentFolderId: parentRef,
});
export const partUrlSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
});
export const completeMultipartSchema = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) }))
    .max(10_000)
    .default([]),
});
export const thumbnailSchema = z.object({ ids: z.array(objectId).min(1).max(100) });

const dateParam = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
  .transform((v) => new Date(v))
  .optional();

export const searchQuery = listQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  folderId: parentRef,
  type: z.enum(['folder', ...FILE_CATEGORIES]).optional(),
  modifiedAfter: dateParam,
  modifiedBefore: dateParam,
});
export const recentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
});
