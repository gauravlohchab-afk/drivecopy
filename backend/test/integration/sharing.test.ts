import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, uploadFile, pdfBytes, pngBytes, type Client } from '../helpers/app.js';

const s3 = createFakeS3();
let alice: Client;
let bob: Client;
let carol: Client;

beforeAll(async () => {
  await setupDb('sharing');
  alice = await signUp('Alice');
  bob = await signUp('Bob');
  carol = await signUp('Carol');
});
afterAll(teardownDb);

const folder = async (c: Client, name: string, parentFolderId: string | null = null) =>
  (await c.post('/api/folders', { name, parentFolderId }).expect(201)).body.folder as { id: string };

describe('sharing a file', () => {
  it('gives read-only access to the person it was shared with, and no one else', async () => {
    const file = await uploadFile(alice, s3, 'report.pdf', pdfBytes());
    await bob.post(`/api/files/${file.id}/download-url`).expect(404);

    const res = await alice.post(`/api/files/${file.id}/shares`, { email: bob.email }).expect(200);
    expect(res.body.people).toEqual([expect.objectContaining({ userId: bob.user.id, name: 'Bob', email: bob.email })]);

    await bob.post(`/api/files/${file.id}/download-url`).expect(200);
    await bob.post(`/api/files/${file.id}/preview-url`).expect(200);
    await carol.post(`/api/files/${file.id}/download-url`).expect(404);

    const shared = await bob.get('/api/shared').expect(200);
    expect(shared.body.files).toEqual([
      expect.objectContaining({ id: file.id, name: 'report.pdf', owner: { name: 'Alice', email: alice.email }, isStarred: false, parentFolderId: null }),
    ]);

    // Read-only: every write is a 404, as if the file didn't exist.
    await bob.patch(`/api/files/${file.id}`, { name: 'x.pdf' }).expect(404);
    await bob.post(`/api/files/${file.id}/move`, { destinationFolderId: null }).expect(404);
    await bob.post(`/api/files/${file.id}/star`, { starred: true }).expect(404);
    await bob.del(`/api/files/${file.id}`).expect(404);
    await bob.get(`/api/files/${file.id}/shares`).expect(404);
    await bob.post(`/api/files/${file.id}/shares`, { email: carol.email }).expect(404);
  });

  it('stops working when the owner unshares, trashes, or permanently deletes', async () => {
    const file = await uploadFile(alice, s3, 'temp.pdf', pdfBytes());
    await alice.post(`/api/files/${file.id}/shares`, { email: bob.email }).expect(200);
    await bob.post(`/api/files/${file.id}/download-url`).expect(200);

    const after = await alice.del(`/api/files/${file.id}/shares/${bob.user.id}`).expect(200);
    expect(after.body.people).toEqual([]);
    await bob.post(`/api/files/${file.id}/download-url`).expect(404);

    await alice.post(`/api/files/${file.id}/shares`, { email: bob.email }).expect(200);
    await alice.del(`/api/files/${file.id}`).expect(200);
    await bob.post(`/api/files/${file.id}/download-url`).expect(404);
    expect((await bob.get('/api/shared').expect(200)).body.files.map((f: { id: string }) => f.id)).not.toContain(file.id);

    // Restoring brings the share back; deleting forever removes it for good.
    await alice.post(`/api/trash/${file.id}/restore`).expect(200);
    await bob.post(`/api/files/${file.id}/download-url`).expect(200);
    await alice.del(`/api/files/${file.id}`).expect(200);
    await alice.del(`/api/trash/${file.id}/permanent`).expect(200);
    await bob.post(`/api/files/${file.id}/download-url`).expect(404);
    const { Share } = await import('../../src/models/index.js');
    expect(await Share.countDocuments({ itemId: file.id })).toBe(0);
  });

  it('rejects unknown emails, sharing with yourself, and other people\'s items', async () => {
    const file = await uploadFile(alice, s3, 'mine.pdf', pdfBytes());
    const unknown = await alice.post(`/api/files/${file.id}/shares`, { email: 'nobody@example.com' }).expect(404);
    expect(unknown.body.error.message).toMatch(/No Ageless Datahub account/);
    await alice.post(`/api/files/${file.id}/shares`, { email: alice.email }).expect(400);
    await alice.post(`/api/files/${file.id}/shares`, { email: 'not-an-email' }).expect(400);
    // Sharing twice is a no-op, not a duplicate.
    await alice.post(`/api/files/${file.id}/shares`, { email: bob.email }).expect(200);
    const twice = await alice.post(`/api/files/${file.id}/shares`, { email: bob.email.toUpperCase() }).expect(200);
    expect(twice.body.people).toHaveLength(1);
  });

  it('lets the viewer remove an item from Shared with me', async () => {
    const file = await uploadFile(alice, s3, 'leave.pdf', pdfBytes());
    await alice.post(`/api/files/${file.id}/shares`, { email: bob.email }).expect(200);
    await carol.del(`/api/shared/${file.id}`).expect(404);
    await bob.del(`/api/shared/${file.id}`).expect(200);
    await bob.post(`/api/files/${file.id}/download-url`).expect(404);
    expect((await alice.get(`/api/files/${file.id}/shares`).expect(200)).body.people).toEqual([]);
  });
});

describe('sharing a folder', () => {
  it('covers everything inside it, including items added later, but nothing outside it', async () => {
    const parent = await folder(alice, 'Private parent');
    const shared = await folder(alice, 'Team', parent.id);
    const inner = await folder(alice, 'Designs', shared.id);
    const sibling = await folder(alice, 'Not shared', parent.id);
    const outside = await uploadFile(alice, s3, 'outside.pdf', pdfBytes(), sibling.id);

    await alice.post(`/api/folders/${shared.id}/shares`, { email: bob.email }).expect(200);
    const later = await uploadFile(alice, s3, 'later.png', pngBytes(), inner.id);

    const top = await bob.get(`/api/shared/folders/${shared.id}/contents`).expect(200);
    expect(top.body.folders.map((f: { name: string }) => f.name)).toEqual(['Designs']);
    // The breadcrumb starts at the shared folder: the owner's "Private parent" stays hidden.
    expect(top.body.path.map((c: { name: string }) => c.name)).toEqual(['Team']);

    const deep = await bob.get(`/api/shared/folders/${inner.id}/contents`).expect(200);
    expect(deep.body.path.map((c: { name: string }) => c.name)).toEqual(['Team', 'Designs']);
    expect(deep.body.files.map((f: { name: string }) => f.name)).toEqual(['later.png']);
    await bob.post(`/api/files/${later.id}/download-url`).expect(200);
    const thumbs = await bob.post('/api/files/thumbnail-urls', { ids: [later.id, outside.id] }).expect(200);
    expect(Object.keys(thumbs.body.urls)).toEqual([later.id]);

    await bob.get(`/api/shared/folders/${parent.id}/contents`).expect(404);
    await bob.get(`/api/shared/folders/${sibling.id}/contents`).expect(404);
    await bob.post(`/api/files/${outside.id}/download-url`).expect(404);
    await carol.get(`/api/shared/folders/${shared.id}/contents`).expect(404);

    // The owner's own routes stay private to the owner.
    await bob.get(`/api/folders/${shared.id}/contents`).expect(404);
    await bob.post('/api/folders', { name: 'x', parentFolderId: shared.id }).expect(404);
    await bob.post('/api/uploads/initiate', { name: 'x.pdf', size: 10, parentFolderId: shared.id }).expect(404);
  });

  it('follows moves: a file moved out of the shared folder is no longer visible', async () => {
    const shared = await folder(alice, 'Moving');
    const file = await uploadFile(alice, s3, 'moved.pdf', pdfBytes(), shared.id);
    await alice.post(`/api/folders/${shared.id}/shares`, { email: bob.email }).expect(200);
    await bob.post(`/api/files/${file.id}/download-url`).expect(200);
    await alice.post(`/api/files/${file.id}/move`, { destinationFolderId: null }).expect(200);
    await bob.post(`/api/files/${file.id}/download-url`).expect(404);
  });

  it('hides a trashed folder and its contents', async () => {
    const shared = await folder(alice, 'Soon trashed');
    const file = await uploadFile(alice, s3, 'inside.pdf', pdfBytes(), shared.id);
    await alice.post(`/api/folders/${shared.id}/shares`, { email: bob.email }).expect(200);
    await alice.del(`/api/folders/${shared.id}`).expect(200);
    await bob.get(`/api/shared/folders/${shared.id}/contents`).expect(404);
    await bob.post(`/api/files/${file.id}/download-url`).expect(404);
    expect((await bob.get('/api/shared').expect(200)).body.folders.map((f: { id: string }) => f.id)).not.toContain(shared.id);
  });
});
