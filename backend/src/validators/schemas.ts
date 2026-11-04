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

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username or email is required').max(254),
  password: z.string().min(1, 'Password is required').max(200),
});
export const updateProfileSchema = z.object({ name: z.string().trim().min(1, 'Name is required').max(80) });

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
export const shareSchema = z.object({ email });
const itemRefs = z
  .array(z.object({ id: objectId, kind: z.enum(['file', 'folder']) }))
  .max(25, 'A workspace can hold up to 25 files and folders');
export const createWorkspaceSchema = z.object({ name: itemName, items: itemRefs.default([]) });
export const updateWorkspaceSchema = z
  .object({ name: itemName.optional(), hidden: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.hidden !== undefined, 'Nothing to update');
export const workspaceItemsSchema = z.object({ items: itemRefs.min(1, 'Choose at least one item') });
export const thumbnailSchema = z.object({ ids: z.array(objectId).min(1).max(100) });

const dateParam = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
  .transform((v) => new Date(v))
  .optional();

const flag = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();
const bytes = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();

export const searchQuery = listQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  folderId: parentRef,
  type: z.enum(['folder', ...FILE_CATEGORIES]).optional(),
  modifiedAfter: dateParam,
  modifiedBefore: dateParam,
  owner: z.union([z.enum(['any', 'me', 'others']), email]).optional(),
  location: z.enum(['anywhere', 'mydrive', 'shared']).optional(),
  inTrash: flag,
  starred: flag,
  sharedTo: email.optional(),
  sizeMin: bytes,
  sizeMax: bytes,
});
export const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(1000).optional(),
  q: z.string().trim().max(100).optional(),
  category: z.enum(['file', 'folder', 'sharing', 'auth']).optional(),
  status: z.enum(['SUCCESS', 'FAILED']).optional(),
  from: dateParam,
  to: dateParam,
});
export const recentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
});
