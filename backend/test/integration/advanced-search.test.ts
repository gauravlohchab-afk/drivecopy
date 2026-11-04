import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, uploadFile, pdfBytes, pngBytes, type Client } from '../helpers/app.js';

const s3 = createFakeS3();
let alice: Client;
let bob: Client;
let carol: Client;

const search = async (c: Client, params: Record<string, string>) => {
  const res = await c.get(`/api/search?${new URLSearchParams(params)}`).expect(200);
  return [...res.body.folders, ...res.body.files].map((i: { name: string }) => i.name).sort();
};

beforeAll(async () => {
  await setupDb('advanced_search');
  alice = await signUp('Alice');
  bob = await signUp('Bob');
  carol = await signUp('Carol');

  const plans = (await alice.post('/api/folders', { name: 'Plans' }).expect(201)).body.folder;
  const small = await uploadFile(alice, s3, 'alpha-notes.pdf', pdfBytes(1000), plans.id);
  await alice.post(`/api/files/${small.id}/star`, { starred: true }).expect(200);
  await uploadFile(alice, s3, 'alpha-photo.png', pngBytes(9000));
  const old = await uploadFile(alice, s3, 'alpha-old.pdf', pdfBytes(500));
  await alice.del(`/api/files/${old.id}`).expect(200);
  await alice.post(`/api/folders/${plans.id}/shares`, { email: carol.email }).expect(200);

  const team = (await bob.post('/api/folders', { name: 'Team alpha' }).expect(201)).body.folder;
  const deep = (await bob.post('/api/folders', { name: 'Deep', parentFolderId: team.id }).expect(201)).body.folder;
  await uploadFile(bob, s3, 'alpha-inner.pdf', pdfBytes(2000), deep.id);
  await uploadFile(bob, s3, 'alpha-team.pdf', pdfBytes(3000), team.id);
  await uploadFile(bob, s3, 'alpha-private.pdf', pdfBytes(3000));
  await bob.post(`/api/folders/${team.id}/shares`, { email: alice.email }).expect(200);
});
afterAll(teardownDb);

describe('advanced search', () => {
  it('searches own items and everything inside folders shared with you, never anything else', async () => {
    expect(await search(alice, { q: 'alpha' })).toEqual(['Team alpha', 'alpha-inner.pdf', 'alpha-notes.pdf', 'alpha-photo.png', 'alpha-team.pdf']);
    const res = (await alice.get('/api/search?q=alpha-inner').expect(200)).body;
    expect(res.files[0]).toMatchObject({ name: 'alpha-inner.pdf', owner: { name: 'Bob', email: bob.email }, isStarred: false, parentFolderId: null });
  });

  it('filters by owner and location', async () => {
    expect(await search(alice, { q: 'alpha', owner: 'me' })).toEqual(['alpha-notes.pdf', 'alpha-photo.png']);
    expect(await search(alice, { q: 'alpha', owner: 'others' })).toEqual(['Team alpha', 'alpha-inner.pdf', 'alpha-team.pdf']);
    expect(await search(alice, { q: 'alpha', owner: bob.email })).toEqual(['Team alpha', 'alpha-inner.pdf', 'alpha-team.pdf']);
    expect(await search(alice, { q: 'alpha', owner: alice.email })).toEqual(['alpha-notes.pdf', 'alpha-photo.png']);
    expect(await search(alice, { q: 'alpha', owner: 'nobody@example.com' })).toEqual([]);
    expect(await search(alice, { q: 'alpha', location: 'mydrive' })).toEqual(['alpha-notes.pdf', 'alpha-photo.png']);
    expect(await search(alice, { q: 'alpha', location: 'shared' })).toEqual(['Team alpha', 'alpha-inner.pdf', 'alpha-team.pdf']);
  });

  it('filters by size, type, starred, Trash and who you shared with', async () => {
    expect(await search(alice, { q: 'alpha', sizeMin: '2500' })).toEqual(['alpha-photo.png', 'alpha-team.pdf']);
    expect(await search(alice, { q: 'alpha', sizeMax: '2000' })).toEqual(['alpha-inner.pdf', 'alpha-notes.pdf']);
    expect(await search(alice, { q: 'alpha', type: 'image' })).toEqual(['alpha-photo.png']);
    expect(await search(alice, { q: 'alpha', type: 'folder' })).toEqual(['Team alpha']);
    expect(await search(alice, { starred: 'true' })).toEqual(['alpha-notes.pdf']);
    expect(await search(alice, { inTrash: 'true' })).toEqual(['alpha-old.pdf']);
    expect(await search(alice, { sharedTo: carol.email })).toEqual(['Plans']);
    expect(await search(alice, { sharedTo: bob.email })).toEqual([]);
  });

  it('ignores other people\'s items that were not shared', async () => {
    expect(await search(carol, { q: 'alpha' })).toEqual(['alpha-notes.pdf']);
    expect(await search(carol, { q: 'private' })).toEqual([]);
    await carol.get('/api/search?owner=not-an-email').expect(400);
  });
});
