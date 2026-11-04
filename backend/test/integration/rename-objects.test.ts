import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, uploadFile, pdfBytes, type Client } from '../helpers/app.js';
import { FileModel, UploadSession } from '../../src/models/index.js';
import { renameUuidObjects, type RenamedObject } from '../../src/services/renameObjects.service.js';
import { s3Service } from '../../src/services/s3.service.js';

const s3 = createFakeS3();
let c: Client;
let counter = 0;

beforeAll(async () => {
  await setupDb('rename_objects');
  c = await signUp();
});
beforeEach(async () => {
  s3.heal();
  s3.copyTransform.fn = null;
  await FileModel.deleteMany({});
  await UploadSession.deleteMany({});
  s3.reset();
});
afterAll(teardownDb);

/** A file as older versions stored it: under a UUID, with its session pointing at the same key. */
async function oldFile(name: string, size = 1000) {
  const file = await uploadFile(c, s3, name, pdfBytes(size));
  const uuid = `07fc446e-190b-448d-8d15-${String(++counter).padStart(12, '0')}`;
  const key = `users/${c.user.id}/${uuid}`;
  s3.putObject(key, s3.objects.get(file.s3Key)!.body);
  s3.objects.delete(file.s3Key);
  await FileModel.updateOne({ _id: file.id }, { $set: { s3Key: key } });
  await UploadSession.updateOne({ fileId: file.id }, { $set: { s3Key: key } });
  return { ...file, s3Key: key };
}
const keyOf = async (id: string) => (await FileModel.findById(id).lean())!.s3Key;
const named = (name: string) => `users/${c.user.id}/${name}`;

describe('renaming UUID objects', () => {
  it('changes nothing in a dry run, and shows the plan', async () => {
    const f = await oldFile('Plan.pdf');
    const before = [...s3.objects.keys()].sort();
    const r = await renameUuidObjects({ apply: false });
    expect(r.planned.map((p) => p.to)).toEqual([named('Plan.pdf')]);
    expect(r.renamed).toEqual([]);
    expect([...s3.objects.keys()].sort()).toEqual(before);
    expect(await keyOf(f.id)).toBe(f.s3Key);
  });

  it('moves the object and both records, keeping the content, and serves it under the new key', async () => {
    const f = await oldFile('Master of Business Administration(MBA).pdf', 2048);
    const body = s3.objects.get(f.s3Key)!.body;
    const log: RenamedObject[] = [];
    const r = await renameUuidObjects({ apply: true, onRenamed: (e) => log.push(e) });

    const to = named('Master of Business Administration(MBA).pdf');
    expect(r.renamed.map((e) => e.to)).toEqual([to]);
    expect(log).toEqual([{ fileId: f.id, name: f.name, from: f.s3Key, to }]);
    expect(s3.objects.has(f.s3Key)).toBe(false);
    expect(Buffer.compare(Buffer.from(s3.objects.get(to)!.body), Buffer.from(body))).toBe(0);
    expect(await keyOf(f.id)).toBe(to);
    expect((await UploadSession.findOne({ fileId: f.id }).lean())!.s3Key).toBe(to);
    const url = (await c.post(`/api/files/${f.id}/download-url`).expect(200)).body.url as string;
    expect(decodeURIComponent(url)).toContain(to);
  });

  it('reports each mapping before deleting the original', async () => {
    await oldFile('Order.pdf');
    let originalsAtLogTime = -1;
    await renameUuidObjects({ apply: true, onRenamed: (e) => { originalsAtLogTime = s3.objects.has(e.from) ? 1 : 0; } });
    expect(originalsAtLogTime).toBe(1);
  });

  it('uses the current name, numbers duplicates, and covers Trash', async () => {
    const renamed = await oldFile('Old name.pdf');
    await c.patch(`/api/files/${renamed.id}`, { name: 'New name.pdf' }).expect(200);
    const one = await oldFile('Same.pdf');
    const two = await oldFile('Same.pdf');
    const trashed = await oldFile('Binned.pdf');
    await c.del(`/api/files/${trashed.id}`).expect(200);

    await renameUuidObjects({ apply: true });

    expect(await keyOf(renamed.id)).toBe(named('New name.pdf'));
    expect(await keyOf(one.id)).toBe(named('Same.pdf'));
    expect(await keyOf(two.id)).toBe(named('Same (1).pdf'));
    expect(await keyOf(trashed.id)).toBe(named('Binned.pdf'));
    await c.post(`/api/trash/${trashed.id}/restore`).expect(200);
  });

  it('keeps the existing owner prefix and never overwrites an object already at the new name', async () => {
    const f = await oldFile('Taken.pdf', 1000);
    s3.putObject(named('Taken.pdf'), pdfBytes(7));
    await renameUuidObjects({ apply: true });
    expect(await keyOf(f.id)).toBe(named('Taken (1).pdf'));
    expect(s3.objects.get(named('Taken.pdf'))!.body.byteLength).toBe(7);
  });

  it('leaves files with readable keys alone, and is safe to run again', async () => {
    const readable = await uploadFile(c, s3, 'Already fine.pdf', pdfBytes());
    const f = await oldFile('Once.pdf');
    expect((await renameUuidObjects({ apply: true })).renamed).toHaveLength(1);
    const again = await renameUuidObjects({ apply: true });
    expect(again.planned).toEqual([]);
    expect(await keyOf(readable.id)).toBe(readable.s3Key);
    expect(await keyOf(f.id)).toBe(named('Once.pdf'));
  });

  it('honours the limit, so a single file can be tried first', async () => {
    await oldFile('A.pdf');
    await oldFile('B.pdf');
    expect((await renameUuidObjects({ apply: true, limit: 1 })).renamed.map((e) => e.name)).toEqual(['A.pdf']);
    expect((await renameUuidObjects({ apply: true })).renamed.map((e) => e.name)).toEqual(['B.pdf']);
  });

  it('leaves the file untouched when the copy fails, and can retry', async () => {
    const f = await oldFile('Outage.pdf');
    s3.failNext('CopyObject');
    const r = await renameUuidObjects({ apply: true });
    expect(r.renamed).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(s3.objects.has(f.s3Key)).toBe(true);
    expect(await keyOf(f.id)).toBe(f.s3Key);

    s3.heal();
    expect((await renameUuidObjects({ apply: true })).renamed).toHaveLength(1);
  });

  it('removes a bad copy and keeps the original when verification fails', async () => {
    const f = await oldFile('Corrupt.pdf', 1000);
    s3.copyTransform.fn = (b) => b.slice(0, 10);
    const r = await renameUuidObjects({ apply: true });
    expect(r.skipped.map((s) => s.reason)).toEqual(['The copy did not match the original']);
    expect(s3.objects.has(f.s3Key)).toBe(true);
    expect(s3.objects.has(named('Corrupt.pdf'))).toBe(false);
    expect(await keyOf(f.id)).toBe(f.s3Key);

    // Same size, different bytes.
    s3.copyTransform.fn = (b) => { const x = new Uint8Array(b); x[20] = 1; return x; };
    expect((await renameUuidObjects({ apply: true })).skipped).toHaveLength(1);
    expect(s3.objects.has(f.s3Key)).toBe(true);
  });

  it('leaves the original alone and removes its copy if the file is deleted mid-rename', async () => {
    const f = await oldFile('Racing.pdf');
    const spy = vi.spyOn(s3Service, 'copyObject').mockImplementationOnce(async (from, to) => {
      s3.putObject(to, s3.objects.get(from)!.body);
      await FileModel.updateOne({ _id: f.id }, { $set: { purgePending: true } });
      return true;
    });
    const r = await renameUuidObjects({ apply: true });
    spy.mockRestore();
    expect(r.skipped.map((s) => s.reason)).toEqual(['The file changed during the rename']);
    expect(s3.objects.has(f.s3Key)).toBe(true);
    expect(s3.objects.has(named('Racing.pdf'))).toBe(false);
    expect(await keyOf(f.id)).toBe(f.s3Key);
  });

  it('reports an old object it could not remove, with the file already working from the new key', async () => {
    const f = await oldFile('Stuck.pdf');
    s3.failNext('DeleteObject');
    const r = await renameUuidObjects({ apply: true });
    expect(r.renamed).toHaveLength(1);
    expect(r.leftovers).toEqual([f.s3Key]);
    expect(await keyOf(f.id)).toBe(named('Stuck.pdf'));
    expect(s3.objects.has(named('Stuck.pdf'))).toBe(true);
  });

  it('skips a file whose original is missing', async () => {
    const f = await oldFile('Missing.pdf');
    s3.objects.delete(f.s3Key);
    const r = await renameUuidObjects({ apply: true });
    expect(r.skipped.map((s) => s.reason)).toEqual(['Original object not found']);
    expect(await keyOf(f.id)).toBe(f.s3Key);
  });
});
