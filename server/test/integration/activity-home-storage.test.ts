import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, uploadFile, pdfBytes, pngBytes, type Client } from '../helpers/app.js';

const s3 = createFakeS3();
let alice: Client;
let bob: Client;
let carol: Client;

beforeAll(async () => {
  await setupDb('activity');
  alice = await signUp('Alice');
  bob = await signUp('Bob');
  carol = await signUp('Carol');
});
afterAll(teardownDb);

type Entry = { action: string; item: { name: string; kind: string }; actor: { name: string; isYou: boolean }; target: { name: string } | null; detail: string | null };
const feed = async (c: Client) => (await c.get('/api/activity?limit=100').expect(200)).body.items as Entry[];
const summary = (items: Entry[]) => items.map((e) => `${e.actor.name}:${e.action}:${e.item.name}${e.detail ? `:${e.detail}` : ''}${e.target ? `>${e.target.name}` : ''}`);

describe('activity', () => {
  it('records what happens to items, newest first, and only shows people what concerns them', async () => {
    const folder = (await alice.post('/api/folders', { name: 'Reports' }).expect(201)).body.folder;
    const file = await uploadFile(alice, s3, 'q1.pdf', pdfBytes());
    await alice.patch(`/api/files/${file.id}`, { name: 'q1-final.pdf' }).expect(200);
    await alice.patch(`/api/files/${file.id}`, { isStarred: true }).expect(200); // starring isn't logged
    await alice.post(`/api/files/${file.id}/move`, { destinationFolderId: folder.id }).expect(200);
    await alice.post(`/api/folders/${folder.id}/shares`, { email: bob.email }).expect(200);
    await bob.post(`/api/files/${file.id}/download-url`).expect(200);
    const secret = await uploadFile(alice, s3, 'private.pdf', pdfBytes());
    await alice.del(`/api/files/${secret.id}`).expect(200);
    await alice.post(`/api/trash/${secret.id}/restore`).expect(200);
    await alice.del(`/api/files/${secret.id}`).expect(200);
    await alice.del(`/api/trash/${secret.id}/permanent`).expect(200);

    expect(summary(await feed(alice))).toEqual([
      'Alice:delete:private.pdf',
      'Alice:trash:private.pdf',
      'Alice:restore:private.pdf',
      'Alice:trash:private.pdf',
      'Alice:upload:private.pdf',
      'Bob:download:q1-final.pdf',
      'Alice:share:Reports>Bob',
      'Alice:move:q1-final.pdf:Reports',
      'Alice:rename:q1-final.pdf:q1.pdf',
      'Alice:upload:q1.pdf',
      'Alice:create_folder:Reports',
    ]);
    // Bob sees the share and his own download, never Alice's private work.
    expect(summary(await feed(bob))).toEqual(['Bob:download:q1-final.pdf', 'Alice:share:Reports>Bob']);
    expect(await feed(carol)).toEqual([]);
  });

  it('paginates with a cursor', async () => {
    const dave = await signUp('Dave');
    for (let i = 0; i < 5; i++) await dave.post('/api/folders', { name: `f${i}` }).expect(201);
    const first = (await dave.get('/api/activity?limit=3').expect(200)).body;
    expect(first.items).toHaveLength(3);
    const second = (await dave.get(`/api/activity?limit=3&cursor=${first.nextCursor}`).expect(200)).body;
    expect(second.items.map((e: Entry) => e.item.name)).toEqual(['f1', 'f0']);
    expect(second.nextCursor).toBeNull();
  });
});

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
