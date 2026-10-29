import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, uploadFile, pdfBytes, pngBytes, type Client } from '../helpers/app.js';
import { FileModel, Folder } from '../../src/models/index.js';
import { purgeService } from '../../src/services/trash.service.js';

const s3 = createFakeS3();
let c: Client;
beforeAll(async () => {
  await setupDb('files');
  c = await signUp();
});
afterAll(teardownDb);
beforeEach(() => s3.heal());

const mk = async (name: string, parentFolderId: string | null = null) => (await c.post('/api/folders', { name, parentFolderId }).expect(201)).body.folder;
const usage = async () => (await c.get('/api/storage/usage').expect(200)).body;

describe('file operations', () => {
  it('renames and moves without touching S3 objects', async () => {
    const f = await uploadFile(c, s3, 'draft.pdf', pdfBytes(300));
    const dest = await mk('Archive');
    const calls = s3.mock.calls().length;
    const r = await c.patch(`/api/files/${f.id}`, { name: 'final.pdf' }).expect(200);
    expect(r.body.file.name).toBe('final.pdf');
    await c.post(`/api/files/${f.id}/move`, { destinationFolderId: dest.id }).expect(200);
    expect(s3.mock.calls().length).toBe(calls);
    const doc = await FileModel.findById(f.id).lean();
    expect(doc!.s3Key).toBe(f.s3Key);
    const listing = await c.get(`/api/folders/${dest.id}/contents`).expect(200);
    expect(listing.body.files.map((x: { name: string }) => x.name)).toEqual(['final.pdf']);
  });

  it('issues inline preview URLs for previewable types and attachment download URLs for all', async () => {
    const pdf = await uploadFile(c, s3, 'view me.pdf', pdfBytes(300));
    const prev = await c.post(`/api/files/${pdf.id}/preview-url`).expect(200);
    const pu = new URL(prev.body.url);
    expect(pu.searchParams.get('response-content-disposition')).toMatch(/^inline/);
    expect(pu.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(Number(pu.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(900);
    const dl = await c.post(`/api/files/${pdf.id}/download-url`).expect(200);
    expect(new URL(dl.body.url).searchParams.get('response-content-disposition')).toMatch(/^attachment; filename="view me.pdf"/);

    const zipBody = Buffer.alloc(100);
    Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(zipBody);
    const zip = await uploadFile(c, s3, 'bundle.zip', zipBody);
    await c.post(`/api/files/${zip.id}/preview-url`).expect(415);
    await c.post(`/api/files/${zip.id}/download-url`).expect(200);
  });

  it('returns thumbnail URLs only for the owner\'s images', async () => {
    const img = await uploadFile(c, s3, 'pic.png', pngBytes());
    const pdf = await uploadFile(c, s3, 'doc.pdf', pdfBytes());
    const r = await c.post('/api/files/thumbnail-urls', { ids: [img.id, pdf.id] }).expect(200);
    expect(Object.keys(r.body.urls)).toEqual([img.id]);
  });

  it('stars files and lists them in Starred and Recent', async () => {
    const f = await uploadFile(c, s3, 'star.pdf', pdfBytes());
    await c.post(`/api/files/${f.id}/star`, { starred: true }).expect(200);
    const starred = await c.get('/api/starred').expect(200);
    expect(starred.body.files.map((x: { id: string }) => x.id)).toContain(f.id);
    const recent = await c.get('/api/recent').expect(200);
    expect(recent.body.files[0].id).toBe(f.id);
  });
});

describe('trash', () => {
  it('trashes a folder with its whole subtree, hides it, and restores everything', async () => {
    const top = await mk('Top');
    const mid = await mk('Mid', top.id);
    const file = await uploadFile(c, s3, 'deep.pdf', pdfBytes(), mid.id);
    await c.del(`/api/folders/${top.id}`).expect(200);

    await c.get(`/api/folders/${mid.id}/contents`).expect(404);
    await c.get(`/api/files/${file.id}`).expect(404);
    const search = await c.get('/api/search?q=deep').expect(200);
    expect(search.body.files).toHaveLength(0);
    const trash = await c.get('/api/trash').expect(200);
    expect(trash.body.folders.map((x: { id: string }) => x.id)).toEqual([top.id]);
    expect(trash.body.files.map((x: { id: string }) => x.id)).not.toContain(file.id);

    // Trash counts toward storage (documented policy).
    expect((await usage()).inTrash).toBeGreaterThan(0);

    await c.post(`/api/trash/${top.id}/restore`).expect(200);
    const listing = await c.get(`/api/folders/${mid.id}/contents`).expect(200);
    expect(listing.body.files.map((x: { id: string }) => x.id)).toEqual([file.id]);
    expect(listing.body.path.map((p: { name: string }) => p.name)).toEqual(['Top', 'Mid']);
  });

  it('keeps independently trashed children separate from a later parent trash', async () => {
    const p = await mk('Parent');
    const f = await uploadFile(c, s3, 'early.pdf', pdfBytes(), p.id);
    await c.del(`/api/files/${f.id}`).expect(200);
    await c.del(`/api/folders/${p.id}`).expect(200);
    await c.post(`/api/trash/${p.id}/restore`).expect(200);
    // The file was trashed on its own, so it stays in Trash.
    const trash = await c.get('/api/trash').expect(200);
    expect(trash.body.files.map((x: { id: string }) => x.id)).toContain(f.id);
  });

  it('restores to My Drive when the original parent no longer exists or is in Trash', async () => {
    const p = await mk('Gone');
    const f = await uploadFile(c, s3, 'orphan-candidate.pdf', pdfBytes(), p.id);
    await c.del(`/api/files/${f.id}`).expect(200);
    await c.del(`/api/folders/${p.id}`).expect(200);
    const r = await c.post(`/api/trash/${f.id}/restore`).expect(200);
    expect(r.body.restoredToRoot).toBe(true);
    const root = await c.get('/api/folders/root/contents').expect(200);
    expect(root.body.files.map((x: { id: string }) => x.id)).toContain(f.id);
  });

  it('permanently deletes S3 objects and metadata and frees storage', async () => {
    const before = await usage();
    const folder = await mk('ToPurge');
    const a = await uploadFile(c, s3, 'a.pdf', pdfBytes(400), folder.id);
    const b = await uploadFile(c, s3, 'b.pdf', pdfBytes(600), folder.id);
    expect((await usage()).used - before.used).toBe(1000);

    // Purge requires the item to be in Trash first.
    await c.del(`/api/trash/${folder.id}/permanent`).expect(404);
    await c.del(`/api/folders/${folder.id}`).expect(200);
    const res = await c.del(`/api/trash/${folder.id}/permanent`).expect(200);
    expect(res.body).toMatchObject({ deletedFiles: 2, deletedFolders: 1, freedBytes: 1000 });
    expect(s3.objects.has(a.s3Key)).toBe(false);
    expect(s3.objects.has(b.s3Key)).toBe(false);
    expect(await FileModel.countDocuments({ _id: { $in: [a.id, b.id] } })).toBe(0);
    expect(await Folder.countDocuments({ _id: folder.id })).toBe(0);
    expect((await usage()).used).toBe(before.used);
  });

  it('retries partial S3 delete failures instead of orphaning metadata or objects', async () => {
    const before = await usage();
    const keep = await uploadFile(c, s3, 'stubborn.pdf', pdfBytes(250));
    await c.del(`/api/files/${keep.id}`).expect(200);
    s3.failDeleteFor(keep.s3Key);
    const r = await c.del(`/api/trash/${keep.id}/permanent`).expect(200);
    expect(r.body.pendingRetries).toBe(1);
    // Still recorded (hidden, pending purge) and still counted, because the bytes still exist.
    const doc = await FileModel.findById(keep.id).lean();
    expect(doc!.purgePending).toBe(true);
    expect(s3.objects.has(keep.s3Key)).toBe(true);
    expect((await c.get('/api/trash').expect(200)).body.files.map((x: { id: string }) => x.id)).not.toContain(keep.id);

    s3.heal();
    const retry = await purgeService.run();
    expect(retry.deletedFiles).toBe(1);
    expect(await FileModel.exists({ _id: keep.id })).toBeNull();
    expect((await usage()).used).toBe(before.used);
  });

  it('empties the whole trash', async () => {
    const x = await uploadFile(c, s3, 'x.pdf', pdfBytes());
    await c.del(`/api/files/${x.id}`).expect(200);
    await c.del('/api/trash').expect(200);
    expect((await c.get('/api/trash').expect(200)).body).toEqual({ folders: [], files: [] });
  });
});

describe('search and listing', () => {
  it('searches by name with type, scope and date filters and paginates with cursors', async () => {
    const s = await signUp('Searcher');
    const proj = (await s.post('/api/folders', { name: 'Budget plans' }).expect(201)).body.folder;
    for (let i = 0; i < 5; i++) await uploadFile(s, s3, `budget-${i}.pdf`, pdfBytes(100 + i), proj.id);
    await uploadFile(s, s3, 'budget.png', pngBytes());
    await uploadFile(s, s3, 'other.pdf', pdfBytes());

    const all = await s.get('/api/search?q=BUDGET').expect(200);
    expect(all.body.folders.map((f: { name: string }) => f.name)).toEqual(['Budget plans']);
    expect(all.body.files).toHaveLength(6);

    const images = await s.get('/api/search?q=budget&type=image').expect(200);
    expect(images.body.files.map((f: { name: string }) => f.name)).toEqual(['budget.png']);
    expect(images.body.folders).toEqual([]);

    const scoped = await s.get(`/api/search?q=budget&folderId=${proj.id}`).expect(200);
    expect(scoped.body.files).toHaveLength(5);

    const future = await s.get('/api/search?q=budget&modifiedAfter=2999-01-01').expect(200);
    expect(future.body.files).toHaveLength(0);

    // Regex metacharacters are literal.
    expect((await s.get('/api/search?q=.*').expect(200)).body.files).toHaveLength(0);

    const page1 = await s.get(`/api/folders/${proj.id}/contents?sort=size&order=desc&limit=2`).expect(200);
    expect(page1.body.files.map((f: { size: number }) => f.size)).toEqual([104, 103]);
    const page2 = await s.get(`/api/folders/${proj.id}/contents?sort=size&order=desc&limit=2&cursor=${page1.body.nextCursor}`).expect(200);
    expect(page2.body.files.map((f: { size: number }) => f.size)).toEqual([102, 101]);
    const page3 = await s.get(`/api/folders/${proj.id}/contents?sort=size&order=desc&limit=2&cursor=${page2.body.nextCursor}`).expect(200);
    expect(page3.body.files.map((f: { size: number }) => f.size)).toEqual([100]);
    expect(page3.body.nextCursor).toBeNull();
    await s.get(`/api/folders/${proj.id}/contents?cursor=garbage`).expect(400);
  });
});
