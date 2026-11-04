import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signInAsAdmin, uploadFile, pdfBytes, type Client } from '../helpers/app.js';
import { Lock, StorageStats, User } from '../../src/models/index.js';
import { s3Service } from '../../src/services/s3.service.js';
import { humanSize, s3StatsService } from '../../src/services/s3Stats.service.js';

const s3 = createFakeS3();
let admin: Client;

beforeAll(async () => {
  await setupDb('s3_stats');
  admin = await signInAsAdmin();
});
beforeEach(async () => {
  s3.reset();
  s3.listPageSize.value = 1000;
  await StorageStats.deleteMany({});
});
afterAll(teardownDb);

const stats = async () => (await admin.get('/api/storage/s3').expect(200)).body;
const listCalls = () => s3.mock.calls().filter((c) => c.args[0].constructor.name === 'ListObjectsV2Command').length;

describe('S3 storage figures', () => {
  it('reports what is really in the bucket, with no capacity figure', async () => {
    s3.putObject('users/a/1', new Uint8Array(1000));
    s3.putObject('users/b/2', new Uint8Array(2048));
    const body = await stats();
    expect(body).toMatchObject({ storageType: 'Amazon S3', status: 'connected', totalBytes: 3048, totalFiles: 2, totalSize: '3.0 KB' });
    expect(new Date(body.lastVerifiedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(JSON.stringify(body)).not.toMatch(/quota|capacity|limit|percent|remaining/i);
  });

  it('follows pagination through a bucket larger than one listing page', async () => {
    for (let i = 0; i < 25; i++) s3.putObject(`users/a/${i}`, new Uint8Array(10));
    s3.listPageSize.value = 4;
    expect(await stats()).toMatchObject({ totalBytes: 250, totalFiles: 25 });
  });

  it('counts user files only, not activity logs or anything else in the bucket', async () => {
    s3.putObject('users/a/1', new Uint8Array(100));
    s3.putObject('activity-logs/2026/11/04/activity-1.jsonl', new Uint8Array(5000));
    s3.putObject('unrelated/thing', new Uint8Array(7000));
    expect(await stats()).toMatchObject({ totalBytes: 100, totalFiles: 1 });
  });

  it('serves page loads from the cache instead of listing the bucket again', async () => {
    s3.putObject('users/a/1', new Uint8Array(100));
    await stats();
    s3.mock.resetHistory();
    for (let i = 0; i < 5; i++) await stats();
    expect(listCalls()).toBe(0);
  });

  it('goes up after an upload and down only after permanent deletion, without re-listing', async () => {
    await stats();
    s3.mock.resetHistory();
    const file = await uploadFile(admin, s3, 'a.pdf', pdfBytes(4000));
    expect(await stats()).toMatchObject({ totalBytes: 4000, totalFiles: 1 });

    // Trash keeps the object in S3, so it still counts.
    await admin.del(`/api/files/${file.id}`).expect(200);
    expect(await stats()).toMatchObject({ totalBytes: 4000, totalFiles: 1 });

    await admin.del(`/api/trash/${file.id}/permanent`).expect(200);
    expect(await stats()).toMatchObject({ totalBytes: 0, totalFiles: 0, totalSize: '0 B' });
    expect(listCalls()).toBe(0);
  });

  it('does not count uploads that fail or are cancelled', async () => {
    await stats();
    const init = await admin.post('/api/uploads/initiate', { name: 'a.pdf', size: 1000, parentFolderId: null }).expect(201);
    await admin.post(`/api/uploads/${init.body.uploadId}/cancel`).expect(200);
    expect(await stats()).toMatchObject({ totalBytes: 0, totalFiles: 0 });
  });

  it('a full listing corrects any drift', async () => {
    s3.putObject('users/a/1', new Uint8Array(100));
    await stats();
    await StorageStats.updateOne({ _id: 's3' }, { $set: { totalBytes: 999_999, totalFiles: 42 } });
    await s3StatsService.refresh();
    expect(await stats()).toMatchObject({ totalBytes: 100, totalFiles: 1 });
  });

  it('does not let a listing replace figures that changed while it ran', async () => {
    s3.putObject('users/a/1', new Uint8Array(100));
    await stats();
    const real = s3Service.listObjects.bind(s3Service);
    const spy = vi.spyOn(s3Service, 'listObjects').mockImplementation(async function* (prefix: string) {
      yield* real(prefix);
      await s3StatsService.adjust(500, 1); // An upload lands while the listing is running.
    });
    await s3StatsService.refresh();
    spy.mockRestore();
    expect(await stats()).toMatchObject({ totalBytes: 600, totalFiles: 2 });
  });

  it('never invents a number: nothing to show until a listing has succeeded', async () => {
    s3.failNext('ListObjectsV2');
    expect(await stats()).toMatchObject({ status: 'unavailable', totalBytes: null, totalFiles: null, totalSize: null, lastVerifiedAt: null });
  });

  it('keeps showing the last verified figures, with their time, during an outage', async () => {
    s3.putObject('users/a/1', new Uint8Array(100));
    const good = await stats();
    s3.failNext('ListObjectsV2');
    await s3StatsService.refresh();
    expect(await stats()).toMatchObject({ status: 'unavailable', totalBytes: 100, totalFiles: 1, lastVerifiedAt: good.lastVerifiedAt });
    s3.heal();
    await s3StatsService.refresh();
    expect((await stats()).status).toBe('connected');
  });

  it('recovers by itself after a failed listing, the next time someone looks', async () => {
    s3.putObject('users/a/1', new Uint8Array(100));
    await stats();
    await StorageStats.updateOne({ _id: 's3' }, { $set: { lastErrorAt: new Date(Date.now() - 120_000) } });
    expect((await stats()).status).toBe('unavailable');
    await vi.waitFor(async () => expect((await stats()).status).toBe('connected'));
  });

  it('a lock left by a crashed process only blocks listings until it expires', async () => {
    s3.putObject('users/a/1', new Uint8Array(100));
    await Lock.create({ _id: 'job:s3-stats', expiresAt: new Date(Date.now() + 60_000) });
    await s3StatsService.refresh();
    expect(await StorageStats.exists({ _id: 's3', lastVerifiedAt: { $ne: null } })).toBeNull();
    await Lock.updateOne({ _id: 'job:s3-stats' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await s3StatsService.refresh();
    expect(await stats()).toMatchObject({ status: 'connected', totalFiles: 1 });
  });

  it('formats sizes for people', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(1536)).toBe('1.5 KB');
    expect(humanSize(5 * 1024 ** 2)).toBe('5.0 MB');
    expect(humanSize(2.5 * 1024 ** 3)).toBe('2.5 GB');
    expect(humanSize(3 * 1024 ** 4)).toBe('3.0 TB');
  });
});

describe('no storage quota', () => {
  it('accepts uploads however much is already stored, even with an old quota value on the account', async () => {
    await User.updateOne({ _id: admin.user.id }, { $set: { storageQuota: 10, storageUsed: 20 * 1024 ** 3 } });
    const init = await admin.post('/api/uploads/initiate', { name: 'big.pdf', size: 1000, parentFolderId: null }).expect(201);
    await admin.post(`/api/uploads/${init.body.uploadId}/cancel`).expect(200);
    await User.updateOne({ _id: admin.user.id }, { $set: { storageUsed: 0 } });
  });

  it('accepts many concurrent uploads without any BUSY or space errors', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => admin.post('/api/uploads/initiate', { name: `f${i}.pdf`, size: 50 * 1024 * 1024, parentFolderId: null })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    await Promise.all(results.map((r) => admin.post(`/api/uploads/${r.body.uploadId}/cancel`).expect(200)));
  });

  it('still enforces the per-file limit, which is validation rather than a quota', async () => {
    const res = await admin.post('/api/uploads/initiate', { name: 'huge.pdf', size: 201 * 1024 * 1024, parentFolderId: null }).expect(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('never mentions a quota in what the API returns', async () => {
    const me = (await admin.get('/api/auth/me').expect(200)).body;
    const usage = (await admin.get('/api/storage/usage').expect(200)).body;
    expect(JSON.stringify([me, usage])).not.toMatch(/quota|remaining/i);
    expect(Object.keys(usage).sort()).toEqual(['inTrash', 'reserved', 'used']);
  });
});
