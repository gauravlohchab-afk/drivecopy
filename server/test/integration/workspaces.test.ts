import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, uploadFile, pdfBytes, type Client } from '../helpers/app.js';

const s3 = createFakeS3();
let alice: Client;
let bob: Client;

beforeAll(async () => {
  await setupDb('workspaces');
  alice = await signUp('Alice');
  bob = await signUp('Bob');
});
afterAll(teardownDb);

const names = (b: { folders: { name: string }[]; files: { name: string }[] }) => [...b.folders, ...b.files].map((i) => i.name);

describe('workspaces', () => {
  it('collects own and shared items, and drops ones that are trashed or unshared', async () => {
    const folder = (await alice.post('/api/folders', { name: 'Launch' }).expect(201)).body.folder;
    const plan = await uploadFile(alice, s3, 'plan.pdf', pdfBytes());
    const bobFile = await uploadFile(bob, s3, 'brief.pdf', pdfBytes());
    await bob.post(`/api/files/${bobFile.id}/shares`, { email: alice.email }).expect(200);

    const ws = (await alice.post('/api/workspaces', { name: 'Q3 launch', items: [{ id: folder.id, kind: 'folder' }] }).expect(201)).body.workspace;
    expect(ws).toMatchObject({ name: 'Q3 launch', hidden: false, itemCount: 1 });
    await alice.post(`/api/workspaces/${ws.id}/items`, { items: [{ id: plan.id, kind: 'file' }, { id: bobFile.id, kind: 'file' }, { id: plan.id, kind: 'file' }] }).expect(200);

    let open = (await alice.get(`/api/workspaces/${ws.id}`).expect(200)).body;
    expect(open.workspace.itemCount).toBe(3); // the duplicate was ignored
    expect(names(open).sort()).toEqual(['Launch', 'brief.pdf', 'plan.pdf']);
    expect(open.files.find((f: { name: string }) => f.name === 'brief.pdf').owner).toEqual({ name: 'Bob', email: bob.email });

    await alice.del(`/api/files/${plan.id}`).expect(200);
    await bob.del(`/api/files/${bobFile.id}/shares/${alice.user.id}`).expect(200);
    open = (await alice.get(`/api/workspaces/${ws.id}`).expect(200)).body;
    expect(names(open)).toEqual(['Launch']);
    expect(open.unavailable).toBe(2);

    // Restoring brings the reference back.
    await alice.post(`/api/trash/${plan.id}/restore`).expect(200);
    open = (await alice.get(`/api/workspaces/${ws.id}`).expect(200)).body;
    expect(names(open).sort()).toEqual(['Launch', 'plan.pdf']);

    await alice.del(`/api/workspaces/${ws.id}/items/${plan.id}`).expect(200);
    expect(names((await alice.get(`/api/workspaces/${ws.id}`).expect(200)).body)).toEqual(['Launch']);
    // Removing from a workspace never touches the file itself.
    await alice.post(`/api/files/${plan.id}/download-url`).expect(200);
  });

  it('is private to its owner, and only accepts items the owner can read', async () => {
    const ws = (await alice.post('/api/workspaces', { name: 'Private' }).expect(201)).body.workspace;
    await bob.get(`/api/workspaces/${ws.id}`).expect(404);
    await bob.patch(`/api/workspaces/${ws.id}`, { name: 'x' }).expect(404);
    await bob.del(`/api/workspaces/${ws.id}`).expect(404);
    expect((await bob.get('/api/workspaces').expect(200)).body.workspaces.map((w: { id: string }) => w.id)).not.toContain(ws.id);

    const secret = await uploadFile(bob, s3, 'secret.pdf', pdfBytes());
    await alice.post(`/api/workspaces/${ws.id}/items`, { items: [{ id: secret.id, kind: 'file' }] }).expect(404);
    await alice.post('/api/workspaces', { name: 'Sneaky', items: [{ id: secret.id, kind: 'file' }] }).expect(404);
    const mine = await uploadFile(bob, s3, 'bobs.pdf', pdfBytes());
    await bob.post(`/api/workspaces/${ws.id}/items`, { items: [{ id: mine.id, kind: 'file' }] }).expect(404);
  });

  it('renames, hides, deletes and enforces the 25-item limit', async () => {
    const ws = (await alice.post('/api/workspaces', { name: 'Draft' }).expect(201)).body.workspace;
    expect((await alice.patch(`/api/workspaces/${ws.id}`, { name: 'Final', hidden: true }).expect(200)).body.workspace).toMatchObject({ name: 'Final', hidden: true });
    await alice.patch(`/api/workspaces/${ws.id}`, { name: '   ' }).expect(400);

    const files = [];
    for (let i = 0; i < 26; i++) files.push(await uploadFile(alice, s3, `f${i}.pdf`, pdfBytes(100)));
    await alice.post(`/api/workspaces/${ws.id}/items`, { items: files.slice(0, 20).map((f) => ({ id: f.id, kind: 'file' })) }).expect(200);
    const over = await alice.post(`/api/workspaces/${ws.id}/items`, { items: files.slice(20).map((f) => ({ id: f.id, kind: 'file' })) }).expect(400);
    expect(over.body.error.message).toMatch(/up to 25/);
    await alice.post(`/api/workspaces/${ws.id}/items`, { items: files.slice(20, 25).map((f) => ({ id: f.id, kind: 'file' })) }).expect(200);

    await alice.del(`/api/workspaces/${ws.id}`).expect(200);
    await alice.get(`/api/workspaces/${ws.id}`).expect(404);
    await alice.post(`/api/files/${files[0]!.id}/download-url`).expect(200);
  });
});
