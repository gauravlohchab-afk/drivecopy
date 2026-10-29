import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, pdfBytes, pngBytes, type Client } from '../helpers/app.js';
import { FileModel, UploadSession, User } from '../../src/models/index.js';
import { uploadMaintenance } from '../../src/services/upload.service.js';
import { s3Service } from '../../src/services/s3.service.js';

const s3 = createFakeS3();
let c: Client;
beforeAll(async () => {
  await setupDb('uploads');
  c = await signUp();
});
afterAll(teardownDb);
beforeEach(() => s3.heal());

function initiate(name: string, size: number, parentFolderId: string | null = null) {
  return c.post('/api/uploads/initiate', { name, size, parentFolderId });
}
async function keyOf(uploadId: string) {
  return (await UploadSession.findById(uploadId).lean())!.s3Key;
}
async function usage() {
  return (await c.get('/api/storage/usage').expect(200)).body;
}

describe('single-part uploads', () => {
  it('returns a short-lived presigned PUT URL with signed content headers and a server-generated key', async () => {
    const res = await initiate('../../etc/passwd.pdf', 1000).expect(201);
    expect(res.body.mode).toBe('single');
    const url = new URL(res.body.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    const key = await keyOf(res.body.uploadId);
    expect(key).toMatch(new RegExp(`^users/${c.user.id}/[0-9a-f-]{36}$`));
    expect(key).not.toContain('passwd');
    const file = await FileModel.findById(res.body.fileId).lean();
    expect(file!.name).toBe('....etcpasswd.pdf');
  });

  it('does not list a file until the server has verified it', async () => {
    const res = await initiate('report.pdf', 1000).expect(201);
    let listing = await c.get('/api/folders/root/contents').expect(200);
    expect(listing.body.files.find((f: { id: string }) => f.id === res.body.fileId)).toBeUndefined();

    // Browser claims success but nothing reached S3: not accepted.
    const early = await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(409);
    expect(early.body.error.code).toBe('UPLOAD_NOT_VERIFIED');

    s3.putObject(await keyOf(res.body.uploadId), pdfBytes(1000));
    const done = await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(200);
    expect(done.body.file).toMatchObject({ name: 'report.pdf', size: 1000, mimeType: 'application/pdf' });
    listing = await c.get('/api/folders/root/contents').expect(200);
    expect(listing.body.files.map((f: { id: string }) => f.id)).toContain(res.body.fileId);
  });

  it('is idempotent: repeated completion returns the same file and never double counts', async () => {
    const before = await usage();
    const res = await initiate('twice.pdf', 2000).expect(201);
    s3.putObject(await keyOf(res.body.uploadId), pdfBytes(2000));
    const [a, b] = await Promise.all([
      c.post(`/api/uploads/${res.body.uploadId}/complete`),
      c.post(`/api/uploads/${res.body.uploadId}/complete`),
    ]);
    expect([a.status, b.status]).toContain(200);
    const again = await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(200);
    expect(again.body.file.id).toBe(res.body.fileId);
    expect(await FileModel.countDocuments({ uploadId: res.body.uploadId })).toBe(1);
    const after = await usage();
    expect(after.used - before.used).toBe(2000);
    expect(after.reserved).toBe(before.reserved);
  });

  it('rejects objects whose size differs from what was reserved', async () => {
    const before = await usage();
    const res = await initiate('liar.pdf', 1000).expect(201);
    s3.putObject(await keyOf(res.body.uploadId), pdfBytes(5000));
    const r = await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(422);
    expect(r.body.error.code).toBe('UPLOAD_NOT_VERIFIED');
    expect(s3.objects.has(await keyOf(res.body.uploadId))).toBe(false);
    const after = await usage();
    expect(after.used).toBe(before.used);
    expect(after.reserved).toBe(before.reserved);
  });

  it('rejects content that does not match its extension (renamed executable)', async () => {
    const res = await initiate('invoice.pdf', 64).expect(201);
    const exe = Buffer.alloc(64);
    exe.write('MZ');
    s3.putObject(await keyOf(res.body.uploadId), exe);
    const r = await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(422);
    expect(r.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('rejects disallowed types and oversized files before issuing any URL', async () => {
    expect((await initiate('evil.exe', 10).expect(415)).body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect((await initiate('page.html', 10).expect(415)).body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect((await initiate('noext', 10).expect(415)).body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect((await initiate('huge.mp4', 201 * 1024 * 1024).expect(413)).body.error.code).toBe('FILE_TOO_LARGE');
    await initiate('neg.pdf', -1).expect(400);
    await initiate('frac.pdf', 1.5).expect(400);
  });

  it('issues a fresh URL for retries after a network failure or expired URL', async () => {
    const res = await initiate('retry.png', 500).expect(201);
    const fresh = await c.post(`/api/uploads/${res.body.uploadId}/url`).expect(200);
    expect(fresh.body.url).toContain('X-Amz-Signature');
    s3.putObject(await keyOf(res.body.uploadId), pngBytes(500));
    await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(200);
  });

  it('refuses completion after the upload session expired and releases the reservation', async () => {
    const before = await usage();
    const res = await initiate('late.pdf', 1000).expect(201);
    await UploadSession.updateOne({ _id: res.body.uploadId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(410);
    expect(r.body.error.code).toBe('UPLOAD_EXPIRED');
    await c.post(`/api/uploads/${res.body.uploadId}/url`).expect(410);
    const result = await uploadMaintenance.run();
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const session = await UploadSession.findById(res.body.uploadId).lean();
    expect(session!.status).toBe('failed');
    expect((await usage()).reserved).toBe(before.reserved);
  });

  it('cancels an upload, deletes partial data and releases quota', async () => {
    const before = await usage();
    const res = await initiate('cancel.pdf', 3000).expect(201);
    expect((await usage()).reserved).toBe(before.reserved + 3000);
    s3.putObject(await keyOf(res.body.uploadId), pdfBytes(3000));
    await c.post(`/api/uploads/${res.body.uploadId}/cancel`).expect(200);
    expect(s3.objects.has(await keyOf(res.body.uploadId))).toBe(false);
    expect((await usage()).reserved).toBe(before.reserved);
    await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(409);
    // Cancelling twice is harmless.
    await c.post(`/api/uploads/${res.body.uploadId}/cancel`).expect(200);
  });

  it('places the file in the destination folder and verifies folder ownership', async () => {
    const folder = (await c.post('/api/folders', { name: 'Docs' }).expect(201)).body.folder;
    const res = await initiate('in-folder.pdf', 100, folder.id).expect(201);
    s3.putObject(await keyOf(res.body.uploadId), pdfBytes(100));
    await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(200);
    const listing = await c.get(`/api/folders/${folder.id}/contents`).expect(200);
    expect(listing.body.files.map((f: { name: string }) => f.name)).toEqual(['in-folder.pdf']);

    const other = await signUp('Mallory');
    await other.post('/api/uploads/initiate', { name: 'x.pdf', size: 10, parentFolderId: folder.id }).expect(404);
  });

  it('a file uploaded into a folder that was trashed meanwhile lands in Trash with it', async () => {
    const folder = (await c.post('/api/folders', { name: 'Doomed' }).expect(201)).body.folder;
    const res = await initiate('inflight.pdf', 100, folder.id).expect(201);
    await c.del(`/api/folders/${folder.id}`).expect(200);
    s3.putObject(await keyOf(res.body.uploadId), pdfBytes(100));
    await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(200);
    const f = await FileModel.findById(res.body.fileId).lean();
    expect(f!.deletedAt).not.toBeNull();
    expect(String(f!.trashRootId)).toBe(folder.id);
  });
});

describe('storage failures and recovery', () => {
  it('surfaces S3 outages as 503 without leaking details and keeps the session retryable', async () => {
    const res = await initiate('outage.pdf', 100).expect(201);
    s3.putObject(await keyOf(res.body.uploadId), pdfBytes(100));
    s3.failNext('HeadObject');
    const r = await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(503);
    expect(r.body.error.code).toBe('STORAGE_UNAVAILABLE');
    expect(JSON.stringify(r.body)).not.toMatch(/amazonaws|bucket|ServiceUnavailable/i);
    s3.heal();
    await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(200);
  });

  it('recovers when S3 succeeded but the metadata update failed', async () => {
    const before = await usage();
    const res = await initiate('dbfail.pdf', 700).expect(201);
    s3.putObject(await keyOf(res.body.uploadId), pdfBytes(700));
    const spy = vi.spyOn(FileModel, 'findOneAndUpdate').mockImplementationOnce((() => {
      throw new Error('simulated database outage');
    }) as never);
    await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(500);
    spy.mockRestore();
    expect((await UploadSession.findById(res.body.uploadId).lean())!.status).toBe('verifying');

    // The maintenance job re-runs verification for sessions stuck in "verifying".
    await UploadSession.updateOne({ _id: res.body.uploadId }, { $set: { updatedAt: new Date(Date.now() - 10 * 60_000) } }, { timestamps: false });
    const result = await uploadMaintenance.run();
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect((await FileModel.findById(res.body.fileId).lean())!.uploadStatus).toBe('completed');
    expect((await usage()).used - before.used).toBe(700);
    // A retry from the browser after recovery is still a clean, idempotent success.
    await c.post(`/api/uploads/${res.body.uploadId}/complete`).expect(200);
  });
});

describe('multipart uploads', () => {
  const MB = 1024 * 1024;

  it('uploads a large file in parts, verifies parts against S3 and completes once', async () => {
    const size = 12 * MB;
    const res = await initiate('movie.mp4', size).expect(201);
    expect(res.body.mode).toBe('multipart');
    expect(res.body.partSize).toBe(5 * MB);
    expect(res.body.partCount).toBe(3);

    const urls = await c.post(`/api/uploads/${res.body.uploadId}/multipart/part-url`, { partNumbers: [1, 2, 3] }).expect(200);
    expect(urls.body.parts.map((p: { size: number }) => p.size)).toEqual([5 * MB, 5 * MB, 2 * MB]);
    await c.post(`/api/uploads/${res.body.uploadId}/multipart/part-url`, { partNumbers: [4] }).expect(400);

    const session = (await UploadSession.findById(res.body.uploadId).lean())!;
    const body = Buffer.alloc(size, 1);
    body.write('\0\0\0\x20ftypisom', 'latin1');
    const etags = [1, 2, 3].map((n) => s3.putPart(session.multipartUploadId!, n, body.subarray((n - 1) * 5 * MB, Math.min(n * 5 * MB, size))));

    // Missing part is reported back so the client can re-send it.
    s3.multipart.get(session.multipartUploadId!)!.parts.delete(2);
    const missing = await c.post(`/api/uploads/${res.body.uploadId}/multipart/complete`, { parts: [] }).expect(409);
    expect(missing.body.error.details.missingParts).toEqual([2]);
    s3.putPart(session.multipartUploadId!, 2, body.subarray(5 * MB, 10 * MB));

    // A client ETag that does not match what S3 stored is refused.
    await c.post(`/api/uploads/${res.body.uploadId}/multipart/complete`, { parts: [{ partNumber: 1, etag: '"bogus"' }] }).expect(409);

    const parts = etags.map((etag, i) => ({ partNumber: i + 1, etag }));
    const done = await c.post(`/api/uploads/${res.body.uploadId}/multipart/complete`, { parts }).expect(200);
    expect(done.body.file).toMatchObject({ name: 'movie.mp4', size, category: 'video' });
    const again = await c.post(`/api/uploads/${res.body.uploadId}/multipart/complete`, { parts }).expect(200);
    expect(again.body.file.id).toBe(done.body.file.id);
  });

  it('aborts multipart uploads on cancel and cleans up orphaned ones', async () => {
    const res = await initiate('abort.mp4', 11 * MB).expect(201);
    const session = (await UploadSession.findById(res.body.uploadId).lean())!;
    expect(s3.multipart.has(session.multipartUploadId!)).toBe(true);
    await c.post(`/api/uploads/${res.body.uploadId}/multipart/abort`).expect(200);
    expect(s3.multipart.has(session.multipartUploadId!)).toBe(false);

    // A multipart upload S3 knows about but no session references (e.g. crash after create).
    const orphanId = await s3Service.createMultipart(`users/${c.user.id}/orphan`, 'video/mp4');
    s3.multipart.get(orphanId)!.initiated = new Date(Date.now() - 48 * 3600_000);
    const result = await uploadMaintenance.run();
    expect(result.abortedOrphans).toBe(1);
    expect(s3.multipart.has(orphanId)).toBe(false);
  });
});

describe('quota enforcement', () => {
  it('blocks uploads beyond the quota, including many concurrent ones', async () => {
    const q = await signUp('Quota');
    await User.updateOne({ _id: q.user.id }, { $set: { storageQuota: 10_000 } });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => q.post('/api/uploads/initiate', { name: `f${i}.pdf`, size: 3000 })));
    const ok = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 413 || r.status === 409).length;
    expect(ok).toBe(3);
    expect(ok + rejected).toBe(10);
    const u = (await q.get('/api/storage/usage').expect(200)).body;
    expect(u.reserved).toBe(9000);
    expect(u.remaining).toBe(1000);
    const over = await q.post('/api/uploads/initiate', { name: 'big.pdf', size: 2000 }).expect(413);
    expect(over.body.error.code).toBe('QUOTA_EXCEEDED');
  });
});
