import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, signInAsAdmin, uploadFile, pdfBytes, pngBytes } from '../helpers/app.js';
import { env } from '../../src/config/env.js';
import { Activity, FileModel, Folder, Session, Share, SharedDrive, UploadSession, User } from '../../src/models/index.js';
import { ensureAdminAccount } from '../../src/services/admin.service.js';

const s3 = createFakeS3();
beforeAll(() => setupDb('admin_migration'));
beforeEach(async () => {
  s3.reset();
  await Promise.all(Object.values(mongoose.models).map((m) => m.deleteMany({})));
});
afterAll(teardownDb);

describe('moving existing accounts to the admin', () => {
  it('keeps every file and its S3 key, and shows each account under its own folder', async () => {
    const alice = await signUp('Alice', 'alice@example.com');
    const bob = await signUp('Bob', 'bob@example.com');
    const folder = (await alice.post('/api/folders', { name: 'Reports' }).expect(201)).body.folder;
    const nested = await uploadFile(alice, s3, 'Master of Business Administration(MBA).pdf', pdfBytes(3000), folder.id);
    const top = await uploadFile(alice, s3, 'top.png', pngBytes(500));
    const bobs = await uploadFile(bob, s3, 'bob.pdf', pdfBytes(700));
    const keys = [nested.s3Key, top.s3Key, bobs.s3Key];
    const objectsBefore = [...s3.objects.keys()].sort();

    const admin = await signInAsAdmin();

    // The bytes in S3 were not touched, and each record still points at the same object.
    expect([...s3.objects.keys()].sort()).toEqual(objectsBefore);
    for (const [id, key] of [[nested.id, nested.s3Key], [top.id, top.s3Key], [bobs.id, bobs.s3Key]] as const) {
      const f = await FileModel.findById(id).lean();
      expect(f!.s3Key).toBe(key);
      expect(String(f!.ownerId)).toBe(admin.user.id);
    }
    expect(keys.every((k) => k.startsWith('users/'))).toBe(true);

    const root = (await admin.get('/api/folders/root/contents').expect(200)).body;
    const names = root.folders.map((f: { name: string }) => f.name).sort();
    expect(names).toEqual(['Imported from alice@example.com', 'Imported from bob@example.com']);
    expect(root.files).toEqual([]);

    const holder = root.folders.find((f: { name: string }) => f.name.includes('alice'));
    const inside = (await admin.get(`/api/folders/${holder.id}/contents`).expect(200)).body;
    expect(inside.folders.map((f: { name: string }) => f.name)).toEqual(['Reports']);
    expect(inside.files.map((f: { name: string }) => f.name)).toEqual(['top.png']);
    const deeper = (await admin.get(`/api/folders/${folder.id}/contents`).expect(200)).body;
    expect(deeper.files.map((f: { name: string }) => f.name)).toEqual(['Master of Business Administration(MBA).pdf']);

    // Still downloadable under the original name, from the same key.
    const url = (await admin.post(`/api/files/${nested.id}/download-url`).expect(200)).body.url as string;
    expect(decodeURIComponent(url)).toContain(nested.s3Key);
    expect(decodeURIComponent(url)).toContain('Master of Business Administration(MBA).pdf');
    await admin.post(`/api/files/${top.id}/preview-url`).expect(200);
  });

  it('carries over Trash, usage counters, workspaces and shared drives', async () => {
    const alice = await signUp('Alice', 'alice@example.com');
    const trashed = await uploadFile(alice, s3, 'gone.pdf', pdfBytes(1000));
    const kept = await uploadFile(alice, s3, 'kept.pdf', pdfBytes(2000));
    await alice.del(`/api/files/${trashed.id}`).expect(200);
    await alice.post('/api/workspaces', { name: 'Work', items: [{ id: kept.id, kind: 'file' }] }).expect(201);
    const drive = (await alice.post('/api/drives', { name: 'Team' }).expect(201)).body.drive;

    const admin = await signInAsAdmin();

    const trash = (await admin.get('/api/trash').expect(200)).body;
    expect(trash.files.map((f: { name: string }) => f.name)).toEqual(['gone.pdf']);
    expect((await admin.get('/api/storage/usage').expect(200)).body).toMatchObject({ used: 3000, inTrash: 1000 });
    expect((await admin.get('/api/workspaces').expect(200)).body.workspaces.map((w: { name: string }) => w.name)).toEqual(['Work']);
    const drives = (await admin.get('/api/drives').expect(200)).body.drives;
    expect(drives).toEqual([expect.objectContaining({ id: drive.id, role: 'manager' })]);

    // Restoring returns it to the imported folder, not somewhere unreachable.
    await admin.post(`/api/trash/${trashed.id}/restore`).expect(200);
    const f = await FileModel.findById(trashed.id).lean();
    expect(String((await Folder.findById(f!.parentFolderId).lean())!.name)).toBe('Imported from alice@example.com');
    await admin.del(`/api/files/${kept.id}`).expect(200);
    await admin.del(`/api/trash/${kept.id}/permanent`).expect(200);
    expect(s3.objects.has(kept.s3Key)).toBe(false);
  });

  it('disables former accounts without deleting them, and ends their sessions', async () => {
    const alice = await signUp('Alice', 'alice@example.com');
    await alice.get('/api/auth/me').expect(200);
    await signInAsAdmin();

    const record = await User.findById(alice.user.id).lean();
    expect(record).toMatchObject({ email: 'alice@example.com', status: 'disabled', storageUsed: 0 });
    expect(record!.mergedIntoUserId).toBeTruthy();
    expect(await Session.exists({ userId: alice.user.id })).toBeNull();
    await alice.get('/api/auth/me').expect(401);
  });

  it('preserves sharing records and legacy activity', async () => {
    const alice = await signUp('Alice', 'alice@example.com');
    const bob = await signUp('Bob', 'bob@example.com');
    const file = await uploadFile(alice, s3, 'shared.pdf', pdfBytes());
    await alice.post(`/api/files/${file.id}/shares`, { email: bob.email }).expect(200);
    await Activity.create({ actorId: alice.user.id, ownerId: alice.user.id, action: 'upload', itemId: file.id, itemKind: 'file', itemName: 'shared.pdf' });

    const admin = await signInAsAdmin();

    const share = await Share.findOne({ itemId: file.id }).lean();
    expect(String(share!.ownerId)).toBe(admin.user.id);
    expect(String(share!.granteeId)).toBe(bob.user.id);
    expect(await Activity.countDocuments()).toBe(1);
  });

  it('is safe to run on every start: nothing moves twice', async () => {
    const alice = await signUp('Alice', 'alice@example.com');
    const file = await uploadFile(alice, s3, 'a.pdf', pdfBytes(1000));
    await ensureAdminAccount();
    const snapshot = () => FileModel.findById(file.id).lean();
    const first = await snapshot();
    await ensureAdminAccount();
    await ensureAdminAccount();
    expect(await Folder.countDocuments({ importedFromUserId: alice.user.id })).toBe(1);
    expect(await User.countDocuments({ role: 'admin' })).toBe(1);
    expect((await snapshot())!.parentFolderId).toEqual(first!.parentFolderId);
    expect((await User.findOne({ role: 'admin' }).lean())!.storageUsed).toBe(1000);
  });

  it('finishes an interrupted move on the next start', async () => {
    const alice = await signUp('Alice', 'alice@example.com');
    const one = await uploadFile(alice, s3, 'one.pdf', pdfBytes(1000));
    const two = await uploadFile(alice, s3, 'two.pdf', pdfBytes(1000));
    const admin = await ensureAdminAccount();
    // As if the process died partway: the second file and the account were not done yet.
    await FileModel.updateOne({ _id: two.id }, { $set: { ownerId: alice.user.id } });
    await User.updateOne({ _id: alice.user.id }, { $set: { status: 'active', mergedIntoUserId: null } });

    await ensureAdminAccount();

    for (const id of [one.id, two.id]) expect(String((await FileModel.findById(id).lean())!.ownerId)).toBe(String(admin._id));
    expect(await Folder.countDocuments({ importedFromUserId: alice.user.id })).toBe(1);
  });

  it('keeps an upload in progress working after the move', async () => {
    const alice = await signUp('Alice', 'alice@example.com');
    const init = await alice.post('/api/uploads/initiate', { name: 'late.pdf', size: 1000, parentFolderId: null }).expect(201);
    const session = await UploadSession.findById(init.body.uploadId).lean();

    const admin = await signInAsAdmin();

    s3.putObject(session!.s3Key, pdfBytes(1000));
    const done = await admin.post(`/api/uploads/${init.body.uploadId}/complete`).expect(200);
    expect(done.body.file.name).toBe('late.pdf');
    expect((await admin.get('/api/storage/usage').expect(200)).body).toMatchObject({ used: 1000, reserved: 0 });
  });

  it('makes an existing account the admin when its email is the configured username, leaving its files in place', async () => {
    const username = env.ADMIN_LOGIN_USERNAME;
    const alice = await signUp('Alice', 'alice@example.com');
    const bob = await signUp('Bob', 'bob@example.com');
    const hers = await uploadFile(alice, s3, 'hers.pdf', pdfBytes());
    await uploadFile(bob, s3, 'his.pdf', pdfBytes());
    env.ADMIN_LOGIN_USERNAME = 'alice@example.com';
    try {
      const admin = await signInAsAdmin();
      expect(admin.user.id).toBe(alice.user.id);
      const root = (await admin.get('/api/folders/root/contents').expect(200)).body;
      expect(root.files.map((f: { id: string }) => f.id)).toEqual([hers.id]);
      expect(root.folders.map((f: { name: string }) => f.name)).toEqual(['Imported from bob@example.com']);
    } finally {
      env.ADMIN_LOGIN_USERNAME = username;
    }
  });

  it('gives the admin manager access to every shared drive without removing members', async () => {
    const alice = await signUp('Alice', 'alice@example.com');
    const drive = (await alice.post('/api/drives', { name: 'Team' }).expect(201)).body.drive;
    const admin = await signInAsAdmin();
    const members = (await SharedDrive.findById(drive.id).lean())!.members.map((m) => [String(m.userId), m.role]);
    expect(members).toEqual(expect.arrayContaining([[alice.user.id, 'manager'], [admin.user.id, 'manager']]));
  });
});
