import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest } from './errors.js';

export const SORT_FIELDS = { name: 'nameLower', modified: 'updatedAt', size: 'size' } as const;
export type SortKey = keyof typeof SORT_FIELDS;

export const listQuerySchema = z.object({
  sort: z.enum(['name', 'modified', 'size']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

interface CursorData {
  v: string | number | null;
  t?: 'd';
  id: string;
}

export function encodeCursor(doc: Record<string, unknown>, field: string): string {
  const raw = doc[field];
  const data: CursorData =
    raw instanceof Date ? { v: raw.toISOString(), t: 'd', id: String(doc._id) } : { v: (raw as string | number) ?? null, id: String(doc._id) };
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

function decodeCursor(cursor: string): { value: unknown; id: Types.ObjectId } {
  try {
    const data = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorData;
    if (!Types.ObjectId.isValid(data.id)) throw new Error('bad id');
    if (data.v !== null && typeof data.v !== 'string' && typeof data.v !== 'number') throw new Error('bad value');
    const value = data.t === 'd' && typeof data.v === 'string' ? new Date(data.v) : data.v;
    return { value, id: new Types.ObjectId(data.id) };
  } catch {
    throw badRequest('Invalid cursor');
  }
}

/** Keyset pagination on (field, _id): stable under inserts and deletes, unlike skip/limit. */
export function keyset(field: string, order: 'asc' | 'desc', cursor?: string) {
  const dir = order === 'asc' ? 1 : -1;
  const sort: Record<string, 1 | -1> = { [field]: dir, _id: dir };
  if (!cursor) return { sort, filter: {} };
  const { value, id } = decodeCursor(cursor);
  const op = dir === 1 ? '$gt' : '$lt';
  return { sort, filter: { $or: [{ [field]: { [op]: value } }, { [field]: value, _id: { [op]: id } }] } };
}

export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
