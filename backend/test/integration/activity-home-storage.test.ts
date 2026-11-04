import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, uploadFile, pdfBytes, pngBytes, type Client } from '../helpers/app.js';

const s3 = createFakeS3();


let carol: Client;

beforeAll(async () => {
  await setupDb('activity');
  carol = await signUp('Carol');
});
afterAll(teardownDb);

describe('home', () => {
  it('suggests the user\'s recently used folders and files plus items shared with them', async () => {
    const erin = await signUp('Erin');
    const frank = await signUp('Frank');
    const old = (await erin.post('/api/folders', { name: 'Old' }).expect(201)).body.folder;
    const fresh = (await erin.post('/api/folders', { name: 'Fresh' }).expect(201)).body.folder;
    const doc = await uploadFile(erin, s3, 'notes.pdf', pdfBytes());
    const home = (await erin.get('/api/home').expect(200)).body;
    expect(home.folders.map((f: { name: string }) => f.name)).toEqual(['Fresh', 'Old']);
    expect(home.files.map((f: { name: string }) => f.name)).toEqual(['notes.pdf']);

    await erin.post(`/api/folders/${fresh.id}/shares`, { email: frank.email }).expect(200);
    await erin.post(`/api/files/${doc.id}/shares`, { email: frank.email }).expect(200);
    const frankHome = (await frank.get('/api/home').expect(200)).body;
    expect(frankHome.folders).toEqual([expect.objectContaining({ name: 'Fresh', owner: { name: 'Erin', email: erin.email } })]);
    expect(frankHome.files).toEqual([expect.objectContaining({ name: 'notes.pdf', owner: { name: 'Erin', email: erin.email } })]);
    expect(frankHome.folders.map((f: { id: string }) => f.id)).not.toContain(old.id);
  });
});

describe('storage breakdown', () => {
  it('reports bytes by type and the largest folders including nested content', async () => {
    const gina = await signUp('Gina');
    const top = (await gina.post('/api/folders', { name: 'Top' }).expect(201)).body.folder;
    const inner = (await gina.post('/api/folders', { name: 'Inner', parentFolderId: top.id }).expect(201)).body.folder;
    await uploadFile(gina, s3, 'a.pdf', pdfBytes(3000), inner.id);
    await uploadFile(gina, s3, 'b.pdf', pdfBytes(1000), top.id);
    await uploadFile(gina, s3, 'c.png', pngBytes(500));
    const trashed = await uploadFile(gina, s3, 'gone.png', pngBytes(9000));
    await gina.del(`/api/files/${trashed.id}`).expect(200);

    const b = (await gina.get('/api/storage/breakdown').expect(200)).body;
    expect(b.byCategory).toEqual([
      { category: 'pdf', bytes: 4000, count: 2 },
      { category: 'image', bytes: 500, count: 1 },
    ]);
    expect(b.largestFolders.map((f: { folder: { name: string }; bytes: number }) => [f.folder.name, f.bytes])).toEqual([
      ['Top', 4000],
      ['Inner', 3000],
    ]);
    // Other users' data never shows up.
    expect((await carol.get('/api/storage/breakdown').expect(200)).body).toEqual({ byCategory: [], largestFolders: [] });
  });
});
