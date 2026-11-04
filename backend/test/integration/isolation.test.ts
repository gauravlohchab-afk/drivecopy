import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, uploadFile, pdfBytes, type Client } from '../helpers/app.js';

const s3 = createFakeS3();
let alice: Client;
let bob: Client;
let aliceFolder: { id: string };
let aliceFile: { id: string };

beforeAll(async () => {
  await setupDb('isolation');
  alice = await signUp('Alice');
  bob = await signUp('Bob');
  aliceFolder = (await alice.post('/api/folders', { name: 'Private' }).expect(201)).body.folder;
  aliceFile = await uploadFile(alice, s3, 'secret.pdf', pdfBytes(), aliceFolder.id);
});
afterAll(teardownDb);

describe('user isolation (IDOR protection)', () => {
  it('another user cannot read, list, or get URLs for someone else\'s items', async () => {
    await bob.get(`/api/folders/${aliceFolder.id}`).expect(404);
    await bob.get(`/api/folders/${aliceFolder.id}/contents`).expect(404);
    await bob.get(`/api/files/${aliceFile.id}`).expect(404);
    await bob.get(`/api/files?folderId=${aliceFolder.id}`).expect(404);
    await bob.post(`/api/files/${aliceFile.id}/download-url`).expect(404);
    await bob.post(`/api/files/${aliceFile.id}/preview-url`).expect(404);
    const thumbs = await bob.post('/api/files/thumbnail-urls', { ids: [aliceFile.id] }).expect(200);
    expect(thumbs.body.urls).toEqual({});
  });

  it('another user cannot modify, move into, trash, restore or purge someone else\'s items', async () => {
    await bob.patch(`/api/files/${aliceFile.id}`, { name: 'pwned.pdf' }).expect(404);
    await bob.patch(`/api/folders/${aliceFolder.id}`, { name: 'pwned' }).expect(404);
    await bob.post(`/api/files/${aliceFile.id}/move`, { destinationFolderId: null }).expect(404);
    await bob.post(`/api/folders/${aliceFolder.id}/move`, { destinationFolderId: null }).expect(404);
    await bob.post(`/api/files/${aliceFile.id}/star`, { starred: true }).expect(404);
    await bob.del(`/api/files/${aliceFile.id}`).expect(404);
    await bob.del(`/api/folders/${aliceFolder.id}`).expect(404);

    const bobFolder = (await bob.post('/api/folders', { name: 'Mine' }).expect(201)).body.folder;
    await bob.post(`/api/folders/${bobFolder.id}/move`, { destinationFolderId: aliceFolder.id }).expect(404);
    await bob.post('/api/folders', { name: 'x', parentFolderId: aliceFolder.id }).expect(404);

    await alice.del(`/api/files/${aliceFile.id}`).expect(200);
    await bob.post(`/api/trash/${aliceFile.id}/restore`).expect(404);
    await bob.del(`/api/trash/${aliceFile.id}/permanent`).expect(404);
    await alice.post(`/api/trash/${aliceFile.id}/restore`).expect(200);
  });

  it('another user cannot drive someone else\'s upload session', async () => {
    const init = await alice.post('/api/uploads/initiate', { name: 'a.pdf', size: 100 }).expect(201);
    await bob.get(`/api/uploads/${init.body.uploadId}`).expect(404);
    await bob.post(`/api/uploads/${init.body.uploadId}/complete`).expect(404);
    await bob.post(`/api/uploads/${init.body.uploadId}/cancel`).expect(404);
    await bob.post(`/api/uploads/${init.body.uploadId}/url`).expect(404);
  });

  it('search, recent, starred and trash never include other users\' items', async () => {
    const s = await bob.get('/api/search?q=secret').expect(200);
    expect(s.body.files).toHaveLength(0);
    expect((await bob.get('/api/recent').expect(200)).body.files).toHaveLength(0);
    const usage = (await bob.get('/api/storage/usage').expect(200)).body;
    expect(usage.used).toBe(0);
  });

  it('ignores client-supplied owner ids', async () => {
    const res = await bob.post('/api/folders', { name: 'sneaky', ownerId: alice.user.id }).expect(201);
    await alice.get(`/api/folders/${res.body.folder.id}`).expect(404);
    await bob.get(`/api/folders/${res.body.folder.id}`).expect(200);
  });
});
