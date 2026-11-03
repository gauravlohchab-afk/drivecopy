import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, pdfBytes, ORIGIN, app, type Client } from '../helpers/app.js';
import request from 'supertest';

const s3 = createFakeS3();
let alice: Client; // manager
let bob: Client; // content manager
let vic: Client; // viewer
let mallory: Client; // not a member
let drive: { id: string };

async function driveUpload(c: Client, driveId: string, name: string, body: Uint8Array, parentFolderId: string | null = null) {
  const { UploadSession } = await import('../../src/models/index.js');
  const init = await c.post(`/api/drives/${driveId}/uploads/initiate`, { name, size: body.byteLength, parentFolderId }).expect(201);
  const session = await UploadSession.findById(init.body.uploadId).lean();
  s3.putObject(session!.s3Key, body);
  return (await c.post(`/api/drives/${driveId}/uploads/${init.body.uploadId}/complete`).expect(200)).body.file as { id: string; name: string; driveId: string };
}

beforeAll(async () => {
  await setupDb('shared_drives');
  alice = await signUp('Alice');
  bob = await signUp('Bob');
  vic = await signUp('Vic');
  mallory = await signUp('Mallory');
  drive = (await alice.post('/api/drives', { name: 'Marketing' }).expect(201)).body.drive;
  await alice.post(`/api/drives/${drive.id}/members`, { email: bob.email, role: 'content_manager' }).expect(200);
  await alice.post(`/api/drives/${drive.id}/members`, { email: vic.email, role: 'viewer' }).expect(200);
});
afterAll(teardownDb);

describe('shared drives', () => {
  it('lists drives with your role, and keeps them invisible to non-members', async () => {
    expect((await alice.get('/api/drives').expect(200)).body.drives).toEqual([expect.objectContaining({ name: 'Marketing', role: 'manager', memberCount: 3, hidden: false })]);
    expect((await vic.get('/api/drives').expect(200)).body.drives[0].role).toBe('viewer');
    expect((await mallory.get('/api/drives').expect(200)).body.drives).toEqual([]);
    await mallory.get(`/api/drives/${drive.id}`).expect(404);
    await mallory.get(`/api/drives/${drive.id}/folders/root/contents`).expect(404);
    await mallory.post(`/api/drives/${drive.id}/folders`, { name: 'x' }).expect(404);
    await mallory.get(`/api/drives/${drive.id}/members`).expect(404);
  });

  it('lets content managers add and organise files that belong to the drive', async () => {
    const folder = (await bob.post(`/api/drives/${drive.id}/folders`, { name: 'Campaigns' }).expect(201)).body.folder;
    expect(folder).toMatchObject({ name: 'Campaigns', driveId: drive.id, driveRole: 'content_manager' });
    const file = await driveUpload(bob, drive.id, 'brief.pdf', pdfBytes(4000), folder.id);
    expect(file.driveId).toBe(drive.id);

    const contents = (await alice.get(`/api/drives/${drive.id}/folders/${folder.id}/contents`).expect(200)).body;
    expect(contents.files.map((f: { name: string }) => f.name)).toEqual(['brief.pdf']);
    expect(contents.path.map((c: { name: string }) => c.name)).toEqual(['Campaigns']);

    await bob.patch(`/api/drives/${drive.id}/files/${file.id}`, { name: 'brief-v2.pdf' }).expect(200);
    await bob.post(`/api/drives/${drive.id}/files/${file.id}/move`, { destinationFolderId: null }).expect(200);
    await bob.post(`/api/drives/${drive.id}/files/${file.id}/star`, { starred: true }).expect(400);

    // Files count against the drive's storage, not the uploader's.
    expect((await bob.get('/api/storage/usage').expect(200)).body.used).toBe(0);
    expect((await alice.get(`/api/drives/${drive.id}`).expect(200)).body.drive.usage.used).toBe(4000);
    // They are not in anyone's My Drive.
    expect((await bob.get('/api/folders/root/contents').expect(200)).body.files).toEqual([]);
    // But regular routes can't reach them, so the drive's rules can't be bypassed.
    await bob.patch(`/api/files/${file.id}`, { name: 'sneaky.pdf' }).expect(404);
  });

  it('gives viewers read-only access', async () => {
    const file = await driveUpload(bob, drive.id, 'view-me.pdf', pdfBytes(1000));
    const root = (await vic.get(`/api/drives/${drive.id}/folders/root/contents`).expect(200)).body;
    expect(root.files.find((f: { name: string }) => f.name === 'view-me.pdf').driveRole).toBe('viewer');
    await vic.post(`/api/drives/${drive.id}/files/${file.id}/download-url`).expect(200);
    await vic.post(`/api/drives/${drive.id}/files/${file.id}/preview-url`).expect(200);
    await vic.post(`/api/drives/${drive.id}/folders`, { name: 'nope' }).expect(403);
    await vic.patch(`/api/drives/${drive.id}/files/${file.id}`, { name: 'x.pdf' }).expect(403);
    await vic.del(`/api/drives/${drive.id}/files/${file.id}`).expect(403);
    await vic.post(`/api/drives/${drive.id}/uploads/initiate`, { name: 'a.pdf', size: 10 }).expect(403);
    await vic.post(`/api/drives/${drive.id}/members`, { email: mallory.email, role: 'viewer' }).expect(403);
  });

  it('has its own Trash, and shows member activity with the real actor', async () => {
    const file = await driveUpload(bob, drive.id, 'old.pdf', pdfBytes(500));
    await bob.del(`/api/drives/${drive.id}/files/${file.id}`).expect(200);
    const trash = (await alice.get(`/api/drives/${drive.id}/trash`).expect(200)).body;
    expect(trash.files.map((f: { name: string }) => f.name)).toContain('old.pdf');
    expect((await bob.get('/api/trash').expect(200)).body.files).toEqual([]);
    await alice.post(`/api/drives/${drive.id}/trash/${file.id}/restore`).expect(200);

    const feed = (await vic.get('/api/activity?limit=50').expect(200)).body.items as { action: string; actor: { name: string }; item: { name: string } }[];
    expect(feed.find((e) => e.action === 'upload' && e.item.name === 'old.pdf')?.actor.name).toBe('Bob');
    expect(feed.find((e) => e.action === 'restore' && e.item.name === 'old.pdf')?.actor.name).toBe('Alice');
    expect((await mallory.get('/api/activity?limit=50').expect(200)).body.items).toEqual([]);
  });

  it('includes drive files in members’ search, tagged with the drive', async () => {
    const hits = (await vic.get('/api/search?q=view-me').expect(200)).body.files;
    expect(hits).toEqual([expect.objectContaining({ name: 'view-me.pdf', driveId: drive.id, driveRole: 'viewer', driveName: 'Marketing' })]);
    expect((await mallory.get('/api/search?q=view-me').expect(200)).body.files).toEqual([]);
  });

  it('manages members: roles, at least one manager, removal revokes access, leaving', async () => {
    await alice.post(`/api/drives/${drive.id}/members`, { email: bob.email, role: 'viewer' }).expect(409);
    await alice.post(`/api/drives/${drive.id}/members`, { email: 'nobody@example.com', role: 'viewer' }).expect(404);
    await alice.patch(`/api/drives/${drive.id}/members/${alice.user.id}`, { role: 'viewer' }).expect(400);
    await alice.del(`/api/drives/${drive.id}/members/${alice.user.id}`).expect(400);

    await alice.patch(`/api/drives/${drive.id}/members/${vic.user.id}`, { role: 'content_manager' }).expect(200);
    await vic.post(`/api/drives/${drive.id}/folders`, { name: 'Vic was here' }).expect(201);
    await alice.patch(`/api/drives/${drive.id}/members/${vic.user.id}`, { role: 'viewer' }).expect(200);
    await vic.post(`/api/drives/${drive.id}/folders`, { name: 'Not anymore' }).expect(403);

    await alice.del(`/api/drives/${drive.id}/members/${vic.user.id}`).expect(200);
    await vic.get(`/api/drives/${drive.id}/folders/root/contents`).expect(404);
    await bob.del(`/api/drives/${drive.id}/members/${bob.user.id}`).expect(200); // leave
    await bob.get(`/api/drives/${drive.id}`).expect(404);
    const members = (await alice.get(`/api/drives/${drive.id}/members`).expect(200)).body.members;
    expect(members.map((m: { name: string; role: string }) => `${m.name}:${m.role}`)).toEqual(['Alice:manager']);
  });

  it('renames, hides per member, and only deletes an empty drive', async () => {
    const d = (await alice.post('/api/drives', { name: 'Temp' }).expect(201)).body.drive;
    await alice.post(`/api/drives/${d.id}/members`, { email: bob.email, role: 'content_manager' }).expect(200);
    await bob.patch(`/api/drives/${d.id}`, { name: 'Hijack' }).expect(403);
    expect((await alice.patch(`/api/drives/${d.id}`, { name: 'Temp 2' }).expect(200)).body.drive.name).toBe('Temp 2');
    await bob.patch(`/api/drives/${d.id}`, { hidden: true }).expect(200);
    expect((await bob.get('/api/drives').expect(200)).body.drives.find((x: { id: string }) => x.id === d.id).hidden).toBe(true);
    expect((await alice.get('/api/drives').expect(200)).body.drives.find((x: { id: string }) => x.id === d.id).hidden).toBe(false);

    const f = await driveUpload(bob, d.id, 'x.pdf', pdfBytes(100));
    await bob.del(`/api/drives/${d.id}`).expect(403);
    await alice.del(`/api/drives/${d.id}`).expect(409);
    await alice.del(`/api/drives/${d.id}/files/${f.id}`).expect(200);
    await alice.del(`/api/drives/${d.id}`).expect(409); // still in the drive's Trash
    await alice.del(`/api/drives/${d.id}/trash`).expect(200);
    await alice.del(`/api/drives/${d.id}`).expect(200);
    await alice.get(`/api/drives/${d.id}`).expect(404);
  });

  it('drive principals can never sign in, and .invalid emails can’t register', async () => {
    const { User } = await import('../../src/models/index.js');
    const principal = await User.findOne({ kind: 'drive' }).lean();
    await request(app()).post('/api/auth/login').set('Origin', ORIGIN).send({ email: principal!.email, password: 'whatever-123' }).expect(401);
    await request(app()).post('/api/auth/register').set('Origin', ORIGIN).send({ name: 'X', email: 'drive-1@shared-drive.invalid', password: 'password1234' }).expect(400);
    // And they can't be added as people.
    await alice.post(`/api/drives/${drive.id}/members`, { email: principal!.email, role: 'viewer' }).expect(404);
  });
});
