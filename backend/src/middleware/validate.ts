import type { Request } from 'express';
import type { z } from 'zod';
import { badRequest } from '../lib/errors.js';

function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest(fields[0]?.message ?? 'Invalid request', { fields });
  }
  return result.data;
}

export const body = <S extends z.ZodType>(req: Request, schema: S) => parse(schema, req.body ?? {});
export const query = <S extends z.ZodType>(req: Request, schema: S) => parse(schema, req.query);
