import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, uploadFile, pdfBytes, type Client } from '../helpers/app.js';
import { FileModel, Folder, UploadSession } from '../../src/models/index.js';
import { s3LayoutService, type MovedObject } from '../../src/services/s3Layout.service.js';
import { s3StatsService } from '../../src/services/s3Stats.service.js';
import { storageService } from '../../src/services/storage.service.js';
import { s3Service } from '../../src/services/s3.service.js';

const s3 = createFakeS3();
let c: Client;
let at: (path: string) => string;

beforeAll(() => setupDb('s3_layout'));
beforeEach(async () => {
  s3.reset();
  s3.copyTransform.fn = null;
  await Promise.all(Object.values(mongoose.models).map((m) => m.deleteMany({})));
  c = await signUp('Ada', 'ada@example.com');
  at = (path) => `users/ada@example.com/${path}`;
});
afterAll(teardownDb);

const sync = () => s3LayoutService.run();
const mkdir = async (name: string, parentFolderId: string | null = null) => (await c.post('/api/folders', { name, parentFolderId }).expect(201)).body.folder as { id: string };
const keyOf = async (id: string) => (await FileModel.findById(id).lean())!.s3Key;
const keys = () => [...s3.objects.keys()].sort();

describe('folders in S3', () => {
  it('shows a new folder under its name, even while empty', async () => {
    const reports = await mkdir('Reports');
    await mkdir('2026', reports.id);
    await sync();
    expect(keys()).toEqual([at('Reports/'), at('Reports/2026/')]);
    expect(s3.objects.get(at('Reports/'))!.body.byteLength).toBe(0);
  });

  it('cleans folder names, and cannot leave the account', async () => {
    await mkdir('a#b?c');
    await mkdir('..hidden');
    await sync();
    expect(keys()).toContain(at('a_b_c/'));
    for (const k of keys()) expect(k.startsWith(at(''))).toBe(true);
    for (const k of keys()) expect(k.slice(at('').length)).not.toContain('..');
  });

  it('does not count folder markers as files, or treat them as orphans', async () => {
    const f = await mkdir('Reports');
    await uploadFile(c, s3, 'a.pdf', pdfBytes(1000), f.id);
    await sync();
    await s3StatsService.refresh();
    expect(await s3StatsService.read()).toMatchObject({ totalFiles: 1, totalBytes: 1000 });

    const old = s3.objects.get(at('Reports/'))!;
    old.lastModified = new Date(Date.now() - 48 * 3600_000);
    const { orphanObjects } = await storageService.reconcileObjects({ deleteOrphans: true });
    expect(orphanObjects).toEqual([]);
    expect(s3.objects.has(at('Reports/'))).toBe(true);
  });

  it('removes the folder from S3 when it is permanently deleted, not when trashed', async () => {
    const f = await mkdir('Gone');
    await sync();
    await c.del(`/api/folders/${f.id}`).expect(200);
    await sync();
    expect(s3.objects.has(at('Gone/'))).toBe(true);
    await c.del(`/api/trash/${f.id}/permanent`).expect(200);
    expect(s3.objects.has(at('Gone/'))).toBe(false);
  });

  it('keeps a shared path until the last folder with that name is gone', async () => {
    const one = await mkdir('Same');
    const two = await mkdir('Same');
    const a = await uploadFile(c, s3, 'a.pdf', pdfBytes(1000), one.id);
    const b = await uploadFile(c, s3, 'a.pdf', pdfBytes(2000), two.id);
    await sync();
    expect(await keyOf(a.id)).toBe(at('Same/a.pdf'));
    expect(await keyOf(b.id)).toBe(at('Same/a (1).pdf'));

    await c.del(`/api/folders/${one.id}`).expect(200);
    await c.del(`/api/trash/${one.id}/permanent`).expect(200);
    expect(s3.objects.has(at('Same/'))).toBe(true);
    expect(s3.objects.get(at('Same/a (1).pdf'))!.body.byteLength).toBe(2000);
  });
});

describe('files follow the app', () => {
  it('uploads straight into the folder path, and at the top of the account otherwise', async () => {
    const reports = await mkdir('Reports');
    const y = await mkdir('2026', reports.id);
    expect((await uploadFile(c, s3, 'Q1 report.pdf', pdfBytes(), y.id)).s3Key).toBe(at('Reports/2026/Q1 report.pdf'));
    expect((await uploadFile(c, s3, 'top.pdf', pdfBytes())).s3Key).toBe(at('top.pdf'));
  });

  it('renames in S3 too, keeping the content, records and modified date', async () => {
    const file = await uploadFile(c, s3, 'old.pdf', pdfBytes(1234));
    const body = s3.objects.get(file.s3Key)!.body;
    await c.patch(`/api/files/${file.id}`, { name: 'new.pdf' }).expect(200);
    const updatedAt = (await FileModel.findById(file.id).lean())!.updatedAt;
    await sync();
    expect(await keyOf(file.id)).toBe(at('new.pdf'));
    expect(s3.objects.has(at('old.pdf'))).toBe(false);
    expect(Buffer.compare(Buffer.from(s3.objects.get(at('new.pdf'))!.body), Buffer.from(body))).toBe(0);
    expect((await UploadSession.findOne({ fileId: file.id }).lean())!.s3Key).toBe(at('new.pdf'));
    expect((await FileModel.findById(file.id).lean())!.updatedAt).toEqual(updatedAt);
    const url = (await c.post(`/api/files/${file.id}/download-url`).expect(200)).body.url as string;
    expect(decodeURIComponent(url)).toContain(at('new.pdf'));
  });

  it('moves in S3 when a file moves between folders', async () => {
    const a = await mkdir('A');
    const b = await mkdir('B');
    const file = await uploadFile(c, s3, 'f.pdf', pdfBytes(), a.id);
    await c.post(`/api/files/${file.id}/move`, { destinationFolderId: b.id }).expect(200);
    await sync();
    expect(await keyOf(file.id)).toBe(at('B/f.pdf'));
    expect(s3.objects.has(at('A/f.pdf'))).toBe(false);
    expect(s3.objects.has(at('A/'))).toBe(true);
  });

  it('carries everything inside when a folder is renamed or moved', async () => {
    const top = await mkdir('Top');
    const inner = await mkdir('Inner', top.id);
    const empty = await mkdir('Empty', inner.id);
    const shallow = await uploadFile(c, s3, 's.pdf', pdfBytes(), top.id);
    const deep = await uploadFile(c, s3, 'd.pdf', pdfBytes(), inner.id);
    await sync();

    await c.patch(`/api/folders/${top.id}`, { name: 'Renamed' }).expect(200);
    await sync();
    expect(keys()).toEqual([at('Renamed/'), at('Renamed/Inner/'), at('Renamed/Inner/Empty/'), at('Renamed/Inner/d.pdf'), at('Renamed/s.pdf')]);
    expect(await keyOf(deep.id)).toBe(at('Renamed/Inner/d.pdf'));

    const dest = await mkdir('Dest');
    await c.post(`/api/folders/${inner.id}/move`, { destinationFolderId: dest.id }).expect(200);
    await sync();
    expect(await keyOf(deep.id)).toBe(at('Dest/Inner/d.pdf'));
    expect(s3.objects.has(at('Dest/Inner/Empty/'))).toBe(true);
    expect(s3.objects.has(at('Renamed/Inner/'))).toBe(false);
    expect(await keyOf(shallow.id)).toBe(at('Renamed/s.pdf'));
    expect((await Folder.findById(empty.id).lean())!.s3Prefix).toBe(at('Dest/Inner/Empty/'));
  });

  it('keeps a file where it is in Trash, and follows it back if restored to the top', async () => {
    const f = await mkdir('Parent');
    const file = await uploadFile(c, s3, 'x.pdf', pdfBytes(), f.id);
    await sync();
    await c.del(`/api/files/${file.id}`).expect(200);
    await sync();
    expect(await keyOf(file.id)).toBe(at('Parent/x.pdf'));
    await c.del(`/api/folders/${f.id}`).expect(200);
    await c.post(`/api/trash/${file.id}/restore`).expect(200);
    await sync();
    expect(await keyOf(file.id)).toBe(at('x.pdf'));
  });

  it('lets a name be used again after a file is permanently deleted', async () => {
    const first = await uploadFile(c, s3, 'again.pdf', pdfBytes());
    await c.del(`/api/files/${first.id}`).expect(200);
    await c.del(`/api/trash/${first.id}/permanent`).expect(200);
    expect((await uploadFile(c, s3, 'again.pdf', pdfBytes())).s3Key).toBe(at('again.pdf'));
  });

  it('puts shared drive files under the drive name, and follows a drive rename', async () => {
    const drive = (await c.post('/api/drives', { name: 'Team' }).expect(201)).body.drive;
    const folder = (await c.post(`/api/drives/${drive.id}/folders`, { name: 'Docs' }).expect(201)).body.folder;
    const init = await c.post(`/api/drives/${drive.id}/uploads/initiate`, { name: 't.pdf', size: 1000, parentFolderId: folder.id }).expect(201);
    const session = await UploadSession.findById(init.body.uploadId).lean();
    expect(session!.s3Key).toBe('users/Shared drive - Team/Docs/t.pdf');
    s3.putObject(session!.s3Key, pdfBytes());
    await c.post(`/api/drives/${drive.id}/uploads/${init.body.uploadId}/complete`).expect(200);
    await sync();

    await c.patch(`/api/drives/${drive.id}`, { name: 'Crew' }).expect(200);
    await sync();
    expect(await keyOf(init.body.fileId)).toBe('users/Shared drive - Crew/Docs/t.pdf');
    expect(s3.objects.has('users/Shared drive - Team/Docs/')).toBe(false);
  });

  it('stays within S3 key limits for very deep trees', async () => {
    let parent: string | null = null;
    for (let i = 0; i < 20; i++) parent = (await mkdir('d'.repeat(100), parent)).id;
    const file = await uploadFile(c, s3, 'deep.pdf', pdfBytes(), parent);
    await sync();
    expect(Buffer.byteLength(await keyOf(file.id))).toBeLessThanOrEqual(1024);
    for (const k of keys()) expect(Buffer.byteLength(k)).toBeLessThanOrEqual(1024);
  });

  it('does no S3 work when nothing needs to change', async () => {
    const f = await mkdir('Stable');
    await uploadFile(c, s3, 'a.pdf', pdfBytes(), f.id);
    await sync();
    await c.patch(`/api/folders/${f.id}`, { isStarred: true }).expect(200);
    s3.mock.resetHistory();
    await sync();
    const writes = s3.mock.calls().filter((x) => /Copy|Put|Delete/.test(x.args[0].constructor.name));
    expect(writes).toEqual([]);
  });
});

describe('when something goes wrong', () => {
  it('keeps the file working from its old key, and retries a failed copy', async () => {
    const file = await uploadFile(c, s3, 'a.pdf', pdfBytes());
    await c.patch(`/api/files/${file.id}`, { name: 'b.pdf' }).expect(200);
    s3.failNext('CopyObject');
    const result = await sync();
    expect(result.failed).toHaveLength(1);
    expect(await keyOf(file.id)).toBe(at('a.pdf'));
    expect(s3.objects.has(at('a.pdf'))).toBe(true);
    await c.post(`/api/files/${file.id}/download-url`).expect(200);
    expect((await FileModel.findById(file.id).lean())!.s3SyncPending).toBe(true);

    s3.heal();
    await sync();
    expect(await keyOf(file.id)).toBe(at('b.pdf'));
    expect((await FileModel.findById(file.id).lean())!.s3SyncPending).toBe(false);
  });

  it('removes a bad copy and keeps the original when verification fails', async () => {
    const file = await uploadFile(c, s3, 'a.pdf', pdfBytes(1000));
    await c.patch(`/api/files/${file.id}`, { name: 'b.pdf' }).expect(200);
    s3.copyTransform.fn = (b) => b.slice(0, 10);
    expect((await sync()).failed.map((f) => f.reason)).toEqual(['The copy did not match the original']);
    expect(s3.objects.has(at('a.pdf'))).toBe(true);
    expect(s3.objects.has(at('b.pdf'))).toBe(false);

    s3.copyTransform.fn = (b) => { const x = new Uint8Array(b); x[20] = 1; return x; };
    expect((await sync()).failed).toHaveLength(1);
    expect(s3.objects.has(at('a.pdf'))).toBe(true);
  });

  it('leaves the original alone and removes its copy if the file is deleted mid-move', async () => {
    const file = await uploadFile(c, s3, 'a.pdf', pdfBytes());
    await c.patch(`/api/files/${file.id}`, { name: 'b.pdf' }).expect(200);
    const spy = vi.spyOn(s3Service, 'copyObject').mockImplementationOnce(async (from, to) => {
      s3.putObject(to, s3.objects.get(from)!.body);
      await FileModel.updateOne({ _id: file.id }, { $set: { purgePending: true } });
      return true;
    });
    await sync();
    spy.mockRestore();
    expect(s3.objects.has(at('a.pdf'))).toBe(true);
    expect(s3.objects.has(at('b.pdf'))).toBe(false);
  });

  it('picks up a rename that lands during the move', async () => {
    const file = await uploadFile(c, s3, 'a.pdf', pdfBytes());
    await c.patch(`/api/files/${file.id}`, { name: 'b.pdf' }).expect(200);
    const real = s3Service.copyObject.bind(s3Service);
    const spy = vi.spyOn(s3Service, 'copyObject').mockImplementationOnce(async (from, to) => {
      const ok = await real(from, to);
      await c.patch(`/api/files/${file.id}`, { name: 'c.pdf' }).expect(200);
      return ok;
    });
    await sync();
    spy.mockRestore();
    expect(await keyOf(file.id)).toBe(at('c.pdf'));
    expect(keys()).toEqual([at('c.pdf')]);
  });

  it('reports an old object it could not remove, with the file working from the new key', async () => {
    const file = await uploadFile(c, s3, 'a.pdf', pdfBytes());
    await c.patch(`/api/files/${file.id}`, { name: 'b.pdf' }).expect(200);
    s3.failNext('DeleteObject');
    const r = await sync();
    expect(r.leftovers).toEqual([at('a.pdf')]);
    expect(await keyOf(file.id)).toBe(at('b.pdf'));
  });

  it('stops looking for an original that is gone', async () => {
    const file = await uploadFile(c, s3, 'a.pdf', pdfBytes());
    await c.patch(`/api/files/${file.id}`, { name: 'b.pdf' }).expect(200);
    s3.objects.delete(at('a.pdf'));
    expect((await sync()).skipped.map((s) => s.reason)).toEqual(['Original object not found']);
    expect((await FileModel.findById(file.id).lean())!.s3SyncPending).toBe(false);
  });

  it('never overwrites an object already at the target key', async () => {
    const file = await uploadFile(c, s3, 'a.pdf', pdfBytes(1000));
    s3.putObject(at('b.pdf'), pdfBytes(7));
    await c.patch(`/api/files/${file.id}`, { name: 'b.pdf' }).expect(200);
    await sync();
    expect(await keyOf(file.id)).toBe(at('b (1).pdf'));
    expect(s3.objects.get(at('b.pdf'))!.body.byteLength).toBe(7);
  });

  it('does not lock anyone out or fail the app when a folder marker cannot be written', async () => {
    s3.failNext('PutObject');
    const f = await mkdir('Later');
    expect((await sync()).failed).toHaveLength(1);
    expect(f.id).toBeTruthy();
    s3.heal();
    await sync();
    expect(s3.objects.has(at('Later/'))).toBe(true);
  });
});

describe('bringing existing data into the layout', () => {
  async function oldFile(name: string, folderId: string | null = null) {
    const file = await uploadFile(c, s3, name, pdfBytes(1000), folderId);
    const key = `users/6ae9b21ece3e251a89620cca/07fc446e-190b-448d-8d15-${String(Math.random()).slice(2, 14).padEnd(12, '0')}`;
    s3.putObject(key, s3.objects.get(file.s3Key)!.body);
    s3.objects.delete(file.s3Key);
    await FileModel.updateOne({ _id: file.id }, { $set: { s3Key: key, s3SyncPending: false } });
    await UploadSession.updateOne({ fileId: file.id }, { $set: { s3Key: key } });
    return { ...file, s3Key: key };
  }

  it('shows the plan without changing anything', async () => {
    const folder = await mkdir('Docs');
    const f = await oldFile('a.pdf', folder.id);
    const before = keys();
    const plan = await s3LayoutService.plan();
    expect(plan.folders).toEqual([at('Docs/')]);
    expect(plan.moves.map((m) => m.to)).toEqual([at('Docs/a.pdf')]);
    expect(keys()).toEqual(before);
    expect(await keyOf(f.id)).toBe(f.s3Key);
  });

  it('moves everything, logging each mapping before deleting the original, and is safe to repeat', async () => {
    const folder = await mkdir('Docs');
    const a = await oldFile('a.pdf', folder.id);
    const b = await oldFile('b.pdf');
    const log: MovedObject[] = [];
    let originalStillThere = false;
    const r = await s3LayoutService.syncExisting({ onMoved: (m) => { log.push(m); originalStillThere = s3.objects.has(m.from); } });
    expect(r.moved).toHaveLength(2);
    expect(originalStillThere).toBe(true);
    expect(log.map((m) => m.from).sort()).toEqual([a.s3Key, b.s3Key].sort());
    expect(keys()).toEqual([at('Docs/'), at('Docs/a.pdf'), at('b.pdf')]);

    expect((await s3LayoutService.syncExisting({})).moved).toEqual([]);
    expect((await s3LayoutService.plan()).moves).toEqual([]);
  });

  it('can do a single file first, leaving the rest alone', async () => {
    await oldFile('a.pdf');
    const b = await oldFile('b.pdf');
    await sync(); // Clears flags set by the set-up uploads.
    const r = await s3LayoutService.syncExisting({ limit: 1 });
    expect(r.moved.map((m) => m.name)).toEqual(['a.pdf']);
    expect(await keyOf(b.id)).toBe(b.s3Key);
    expect((await sync()).moved).toEqual([]);
  });
});
