import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, type Client } from '../helpers/app.js';

createFakeS3();
let c: Client;
beforeAll(async () => {
  await setupDb('folders');
  c = await signUp();
});
afterAll(teardownDb);

const mk = async (name: string, parentFolderId: string | null = null) => (await c.post('/api/folders', { name, parentFolderId }).expect(201)).body.folder;

describe('folders', () => {
  it('creates nested folders and returns breadcrumbs', async () => {
    const a = await mk('Projects');
    const b = await mk('2026', a.id);
    const d = await mk('Q4', b.id);
    const res = await c.get(`/api/folders/${d.id}/contents`).expect(200);
    expect(res.body.path.map((p: { name: string }) => p.name)).toEqual(['Projects', '2026', 'Q4']);
    const root = await c.get('/api/folders/root/contents').expect(200);
    expect(root.body.folders.map((f: { name: string }) => f.name)).toContain('Projects');
  });

  it('validates names', async () => {
    await c.post('/api/folders', { name: '   ' }).expect(400);
    await c.post('/api/folders', { name: '..' }).expect(400);
    await c.post('/api/folders', { name: 'x'.repeat(300) }).expect(400);
    const f = await mk('a/b\\c');
    expect(f.name).toBe('abc');
  });

  it('allows duplicate names as distinct items', async () => {
    const one = await mk('Dup');
    const two = await mk('Dup');
    expect(one.id).not.toBe(two.id);
  });

  it('renames and stars a folder', async () => {
    const f = await mk('Old');
    const r = await c.patch(`/api/folders/${f.id}`, { name: 'New' }).expect(200);
    expect(r.body.folder.name).toBe('New');
    const s = await c.post(`/api/folders/${f.id}/star`, { starred: true }).expect(200);
    expect(s.body.folder.isStarred).toBe(true);
    const starred = await c.get('/api/starred').expect(200);
    expect(starred.body.folders.map((x: { id: string }) => x.id)).toContain(f.id);
  });

  it('moves folders and prevents moving into itself or a descendant', async () => {
    const a = await mk('A');
    const b = await mk('B', a.id);
    const cc = await mk('C', b.id);
    const other = await mk('Other');

    const self = await c.post(`/api/folders/${a.id}/move`, { destinationFolderId: a.id }).expect(400);
    expect(self.body.error.code).toBe('INVALID_MOVE');
    const desc = await c.post(`/api/folders/${a.id}/move`, { destinationFolderId: cc.id }).expect(400);
    expect(desc.body.error.code).toBe('INVALID_MOVE');

    await c.post(`/api/folders/${a.id}/move`, { destinationFolderId: other.id }).expect(200);
    const crumbs = await c.get(`/api/folders/${cc.id}`).expect(200);
    expect(crumbs.body.folder.path.map((p: { name: string }) => p.name)).toEqual(['Other', 'A', 'B', 'C']);

    await c.post(`/api/folders/${a.id}/move`, { destinationFolderId: null }).expect(200);
    const back = await c.get(`/api/folders/${cc.id}`).expect(200);
    expect(back.body.folder.path.map((p: { name: string }) => p.name)).toEqual(['A', 'B', 'C']);
  });

  it('serialises concurrent cross moves so no cycle can form', async () => {
    const x = await mk('X');
    const y = await mk('Y');
    const [r1, r2] = await Promise.all([
      c.post(`/api/folders/${x.id}/move`, { destinationFolderId: y.id }),
      c.post(`/api/folders/${y.id}/move`, { destinationFolderId: x.id }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 400]);
  });

  it('rejects unknown and malformed ids with 404', async () => {
    await c.get('/api/folders/000000000000000000000000').expect(404);
    await c.get('/api/folders/not-an-id').expect(404);
    await c.post('/api/folders', { name: 'n', parentFolderId: '000000000000000000000000' }).expect(404);
  });

  it('ignores operator injection in ids', async () => {
    await c.post('/api/folders', { name: 'n', parentFolderId: { $ne: null } }).expect(400);
  });
});
