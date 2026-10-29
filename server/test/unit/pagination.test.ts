import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { keyset, encodeCursor, escapeRegex } from '../../src/lib/pagination.js';

describe('keyset pagination', () => {
  it('round-trips cursors including dates', () => {
    const id = new Types.ObjectId();
    const d = new Date('2026-01-02T03:04:05.000Z');
    const { filter, sort } = keyset('updatedAt', 'desc', encodeCursor({ _id: id, updatedAt: d }, 'updatedAt'));
    expect(sort).toEqual({ updatedAt: -1, _id: -1 });
    expect(filter).toEqual({ $or: [{ updatedAt: { $lt: d } }, { updatedAt: d, _id: { $lt: id } }] });
  });

  it('rejects tampered cursors', () => {
    expect(() => keyset('size', 'asc', 'not-base64-json')).toThrow(/Invalid cursor/);
    const evil = Buffer.from(JSON.stringify({ v: { $gt: '' }, id: new Types.ObjectId().toString() })).toString('base64url');
    expect(() => keyset('size', 'asc', evil)).toThrow(/Invalid cursor/);
  });

  it('escapes regex metacharacters', () => {
    expect(new RegExp(escapeRegex('a.*(b)')).test('a.*(b)')).toBe(true);
    expect(new RegExp(escapeRegex('.*')).test('anything')).toBe(false);
  });
});
