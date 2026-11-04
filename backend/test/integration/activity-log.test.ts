import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, signUp, signInAsAdmin, uploadFile, pdfBytes, app, ORIGIN, type Client } from '../helpers/app.js';
import { env } from '../../src/config/env.js';
import { Activity, ActivityOutbox, Migration } from '../../src/models/index.js';
import { activityService } from '../../src/services/activity.service.js';
import { s3Service } from '../../src/services/s3.service.js';

const s3 = createFakeS3();
let admin: Client;

beforeAll(async () => {
  await setupDb('activity_log');
  admin = await signInAsAdmin();
});
beforeEach(async () => {
  s3.heal();
  await activityService.flush(2000);
  s3.reset();
  s3.listPageSize.value = 1000;
});
afterAll(teardownDb);

type Entry = { id: string; eventType: string; action: string; status: string; at: string; item: { id: string; kind: string; name: string } | null; details: Record<string, unknown>; target: { name: string } | null };
const page = async (qs = 'limit=100') => (await admin.get(`/api/activity?${qs}`).expect(200)).body as { items: Entry[]; nextCursor: string | null; logStorage: { status: string; pendingEvents: number; reason: string | null } };
const logKeys = () => [...s3.objects.keys()].filter((k) => k.startsWith('activity-logs/')).sort();
const logRecords = () =>
  logKeys().flatMap((k) =>
    Buffer.from(s3.objects.get(k)!.body).toString('utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>),
  );

describe('activity log in S3', () => {
  it('writes each action as JSON under a dated key, and the page reads it back newest first', async () => {
    const folder = (await admin.post('/api/folders', { name: 'Reports' }).expect(201)).body.folder;
    const file = await uploadFile(admin, s3, 'MBA_Certificate.pdf', pdfBytes(2048));
    await admin.post(`/api/files/${file.id}/preview-url`).expect(200);
    await admin.post(`/api/files/${file.id}/download-url`).expect(200);
    await admin.patch(`/api/files/${file.id}`, { name: 'MBA.pdf' }).expect(200);
    await admin.patch(`/api/files/${file.id}`, { isStarred: true }).expect(200); // Starring isn't logged.
    await admin.post(`/api/files/${file.id}/move`, { destinationFolderId: folder.id }).expect(200);
    await admin.del(`/api/files/${file.id}`).expect(200);
    await admin.post(`/api/trash/${file.id}/restore`).expect(200);
    await admin.del(`/api/files/${file.id}`).expect(200);
    await admin.del(`/api/trash/${file.id}/permanent`).expect(200);
    await admin.patch(`/api/folders/${folder.id}`, { name: 'Reports 2' }).expect(200);
    await admin.post(`/api/folders/${folder.id}/move`, { destinationFolderId: null }).expect(200);
    await admin.del(`/api/folders/${folder.id}`).expect(200);

    const { items, logStorage } = await page();
    expect(logStorage).toMatchObject({ status: 'ok', pendingEvents: 0 });
    expect(items.map((e) => e.eventType)).toEqual([
      'FOLDER_DELETED',
      'FOLDER_MOVED',
      'FOLDER_RENAMED',
      'FILE_PERMANENTLY_DELETED',
      'FILE_DELETED',
      'FILE_RESTORED',
      'FILE_DELETED',
      'FILE_MOVED',
      'FILE_RENAMED',
      'FILE_DOWNLOADED',
      'FILE_PREVIEWED',
      'FILE_UPLOADED',
      'FOLDER_CREATED',
    ]);

    for (const key of logKeys()) expect(key).toMatch(/^activity-logs\/\d{4}\/\d{2}\/\d{2}\/activity-\d{8}T\d{9}Z-[0-9a-f-]{36}\.jsonl$/);
    const upload = logRecords().find((r) => r.eventType === 'FILE_UPLOADED')!;
    expect(upload).toMatchObject({
      userId: admin.user.id,
      fileId: file.id,
      fileName: 'MBA_Certificate.pdf',
      action: 'Uploaded a file',
      status: 'SUCCESS',
      details: { fileSize: 2048, mimeType: 'application/pdf' },
    });
    expect(upload.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(upload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // UTC.

    const rename = items.find((e) => e.eventType === 'FILE_RENAMED')!;
    expect(rename.details.previousName).toBe('MBA_Certificate.pdf');
    expect(items.find((e) => e.eventType === 'FILE_MOVED')!.details.destination).toBe('Reports');
    expect(new Set(logRecords().map((r) => r.eventId)).size).toBe(logRecords().length);
  });

  it('keeps logs apart from user files, and never overwrites one', async () => {
    const file = await uploadFile(admin, s3, 'one.pdf', pdfBytes());
    await page();
    const firstKeys = logKeys();
    const firstBodies = firstKeys.map((k) => Buffer.from(s3.objects.get(k)!.body).toString());
    expect(file.s3Key.startsWith('users/')).toBe(true);
    expect(firstKeys.length).toBeGreaterThan(0);

    await admin.post('/api/folders', { name: 'Later' }).expect(201);
    await page();
    expect(logKeys().length).toBeGreaterThan(firstKeys.length);
    expect(firstKeys.map((k) => Buffer.from(s3.objects.get(k)!.body).toString())).toEqual(firstBodies);

    // Even a repeated key cannot replace an existing log.
    expect(await s3Service.putActivityLog(firstKeys[0]!, '{"overwritten":true}\n')).toBe(false);
    expect(Buffer.from(s3.objects.get(firstKeys[0]!)!.body).toString()).toBe(firstBodies[0]);
  });

  it('tracks sign-ins, including failures, without any secret or what was typed', async () => {
    const typed = 'pasted-my-password-by-mistake';
    await request(app()).post('/api/auth/login').set('Origin', ORIGIN).send({ username: typed, password: 'also-a-secret-value' }).expect(401);
    const session = await signInAsAdmin();
    await session.post('/api/auth/logout').expect(204);

    const { items } = await page('category=auth&limit=10');
    expect(items.map((e) => e.eventType)).toEqual(['LOGOUT', 'LOGIN_SUCCESSFUL', 'LOGIN_FAILED']);
    expect(items[2]).toMatchObject({ status: 'FAILED', item: null });

    const everything = logKeys().map((k) => Buffer.from(s3.objects.get(k)!.body).toString()).join('');
    for (const secret of [typed, 'also-a-secret-value', env.ADMIN_LOGIN_PASSWORD, env.SESSION_SECRET, env.AWS_SECRET_ACCESS_KEY!, session.csrf]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('tracks sharing: granted, permissions changed and revoked', async () => {
    const bob = await signUp('Bob');
    const file = await uploadFile(admin, s3, 'shared.pdf', pdfBytes());
    await admin.post(`/api/files/${file.id}/shares`, { email: bob.email }).expect(200);
    await admin.del(`/api/files/${file.id}/shares/${bob.user.id}`).expect(200);
    const drive = (await admin.post('/api/drives', { name: 'Team' }).expect(201)).body.drive;
    await admin.post(`/api/drives/${drive.id}/members`, { email: bob.email, role: 'viewer' }).expect(200);
    await admin.patch(`/api/drives/${drive.id}/members/${bob.user.id}`, { role: 'content_manager' }).expect(200);

    const { items } = await page('category=sharing&limit=10');
    expect(items.map((e) => e.eventType)).toEqual(['SHARING_PERMISSIONS_CHANGED', 'FILE_ACCESS_REVOKED', 'FILE_SHARED']);
    expect(items[0]).toMatchObject({ item: { kind: 'drive', name: 'Team' }, target: { name: 'Bob' }, details: { role: 'content_manager' } });
  });

  it('shows the administrator the full log, and nobody else', async () => {
    const bob = await signUp('Bob');
    await bob.get('/api/activity').expect(403);
    await bob.get('/api/storage/s3').expect(403);
  });

  it('paginates across objects without repeating or skipping', async () => {
    for (let i = 0; i < 7; i++) {
      await admin.post('/api/folders', { name: `f${i}` }).expect(201);
      await page('limit=1'); // Flushes, so each event lands in its own object.
    }
    expect(logKeys().length).toBeGreaterThanOrEqual(7);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body: Awaited<ReturnType<typeof page>> = await page(`limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(body.items.length).toBeLessThanOrEqual(3);
      seen.push(...body.items.map((e) => e.item!.name));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(['f6', 'f5', 'f4', 'f3', 'f2', 'f1', 'f0']);
    expect(pages).toBeGreaterThan(1);
  });

  it('rejects a tampered cursor', async () => {
    const bad = Buffer.from(JSON.stringify({ k: 'users/someone/secret', i: 0 })).toString('base64url');
    await admin.get(`/api/activity?cursor=${bad}`).expect(400);
    await admin.get('/api/activity?cursor=not-a-cursor').expect(400);
  });

  it('searches and filters', async () => {
    await admin.post('/api/folders', { name: 'Invoices' }).expect(201);
    await uploadFile(admin, s3, 'invoice-7.pdf', pdfBytes());
    await request(app()).post('/api/auth/login').set('Origin', ORIGIN).send({ username: 'x', password: 'y' }).expect(401);

    const names = async (qs: string) => (await page(qs)).items.map((e) => e.item?.name ?? e.eventType);
    expect(await names('q=invoice')).toEqual(['invoice-7.pdf', 'Invoices']);
    expect(await names('q=INVOICE&category=folder')).toEqual(['Invoices']);
    expect(await names('category=file')).toEqual(['invoice-7.pdf']);
    expect(await names('status=FAILED')).toEqual(['LOGIN_FAILED']);
    expect(await names('q=nothing-like-this')).toEqual([]);

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect(await names(`from=${tomorrow}`)).toEqual([]);
    expect((await names(`to=${tomorrow}`)).length).toBeGreaterThan(0);
    expect(await names(`to=${new Date(Date.now() - 86_400_000).toISOString()}`)).toEqual([]);
  });

  it('skips days outside a date filter without reading them', async () => {
    const line = (day: string, name: string) => `${JSON.stringify({ eventId: `${day}-${name}`, eventType: 'FOLDER_CREATED', userId: admin.user.id, folderId: '0'.repeat(24), folderName: name, action: 'Created a folder', details: {}, timestamp: `${day}T10:00:00.000Z`, status: 'SUCCESS' })}\n`;
    await s3Service.putActivityLog('activity-logs/2025/01/05/activity-20250105T100000000Z-a.jsonl', line('2025-01-05', 'jan'));
    await s3Service.putActivityLog('activity-logs/2025/03/05/activity-20250305T100000000Z-b.jsonl', line('2025-03-05', 'mar'));
    await s3Service.putActivityLog('activity-logs/2025/12/05/activity-20251205T100000000Z-c.jsonl', line('2025-12-05', 'dec'));

    s3.mock.resetHistory();
    const { items } = await page('from=2025-03-01&to=2025-03-31');
    expect(items.map((e) => e.item!.name)).toEqual(['mar']);
    const read = s3.mock.calls().map((c) => (c.args[0].input as { Key?: string }).Key).filter(Boolean);
    expect(read.some((k) => k!.includes('2025/03/05'))).toBe(true);
    expect(read.some((k) => k!.includes('2025/01/05') || k!.includes('2025/12/05'))).toBe(false);
  });

  it('never skips a record over an unreadable line', async () => {
    const good = JSON.stringify({ eventId: 'ok-1', eventType: 'FOLDER_CREATED', userId: null, folderId: '0'.repeat(24), folderName: 'good', action: 'Created a folder', details: {}, timestamp: '2025-02-02T10:00:00.000Z', status: 'SUCCESS' });
    await s3Service.putActivityLog('activity-logs/2025/02/02/activity-20250202T100000000Z-x.jsonl', `{broken\n${good}\n`);
    expect((await page()).items.map((e) => e.item?.name)).toEqual(['good']);
  });
});

describe('when S3 is unavailable', () => {
  it('keeps events, still shows them, and writes them when access returns', async () => {
    s3.failNext('PutObject');
    s3.failNext('ListObjectsV2');
    await admin.post('/api/folders', { name: 'During outage' }).expect(201); // The operation itself succeeds.

    const during = await page();
    expect(during.logStorage).toMatchObject({ status: 'degraded', pendingEvents: 1 });
    expect(during.items.map((e) => e.item?.name)).toEqual(['During outage']);
    expect(logKeys()).toEqual([]);
    expect(await ActivityOutbox.countDocuments()).toBe(1);

    s3.heal();
    const after = await page();
    expect(after.logStorage).toMatchObject({ status: 'ok', pendingEvents: 0 });
    expect(after.items.map((e) => e.item?.name)).toEqual(['During outage']);
    expect(logRecords().map((r) => r.folderName)).toEqual(['During outage']);
  });

  it('answers from the outbox without calling S3 while permission is denied, and recovers without a restart', async () => {
    s3.deny('PutObject');
    s3.deny('ListObjectsV2');
    await admin.post('/api/folders', { name: 'While denied' }).expect(201);

    const first = await page();
    expect(first.logStorage).toMatchObject({ status: 'degraded', pendingEvents: 1, reason: 'AccessDenied' });

    // Later page views neither wait on S3 nor retry a request that was just refused.
    s3.mock.resetHistory();
    for (let i = 0; i < 3; i++) {
      const again = await page();
      expect(again.items.map((e) => e.item?.name)).toEqual(['While denied']);
      expect(again.logStorage.status).toBe('degraded');
    }
    expect(s3.mock.calls()).toHaveLength(0);

    // Permission granted: the background job's next attempt writes everything and clears the notice.
    s3.heal();
    await activityService.flush(2000);
    const after = await page();
    expect(after.logStorage).toMatchObject({ status: 'ok', pendingEvents: 0, reason: null });
    expect(after.items.map((e) => e.item?.name)).toEqual(['While denied']);
    expect(logRecords().map((r) => r.folderName)).toEqual(['While denied']);
  });

  it('shows one entry for an event written twice by a crash', async () => {
    const record = (name: string) => `${JSON.stringify({ eventId: 'same-id', eventType: 'FOLDER_CREATED', userId: null, folderId: '0'.repeat(24), folderName: name, action: 'Created a folder', details: {}, timestamp: '2025-04-04T10:00:00.000Z', status: 'SUCCESS' })}\n`;
    await s3Service.putActivityLog('activity-logs/2025/04/04/activity-20250404T100000000Z-a.jsonl', record('dup'));
    await s3Service.putActivityLog('activity-logs/2025/04/04/activity-20250404T100000000Z-b.jsonl', record('dup'));
    expect((await page('q=dup')).items).toHaveLength(1);
  });

  it('handles events written concurrently without losing any', async () => {
    const file = await uploadFile(admin, s3, 'busy.pdf', pdfBytes());
    await Promise.all(Array.from({ length: 25 }, () => admin.post(`/api/files/${file.id}/download-url`).expect(200)));
    await Promise.allSettled([activityService.flush(), activityService.flush(), activityService.flush()]);
    await activityService.flush(2000);
    const ids = logRecords().filter((r) => r.eventType === 'FILE_DOWNLOADED').map((r) => r.eventId);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
  });
});

describe('older activity history', () => {
  it('is copied to S3 once, by day, and the originals stay', async () => {
    await Migration.deleteMany({});
    const actorId = admin.user.id;
    const old = { actorId, ownerId: actorId, itemId: '0'.repeat(24), itemKind: 'file' };
    await Activity.collection.insertMany([
      { ...old, action: 'upload', itemName: 'old-a.pdf', detail: null, targetUserId: null, createdAt: new Date('2026-05-01T08:00:00Z') },
      { ...old, action: 'rename', itemName: 'old-b.pdf', detail: 'old-a.pdf', targetUserId: null, createdAt: new Date('2026-05-01T09:00:00Z') },
      { ...old, action: 'download', itemName: 'old-c.pdf', detail: null, targetUserId: null, createdAt: new Date('2026-06-02T09:00:00Z') },
    ] as never[]);

    await activityService.flush(2000);
    expect(logKeys()).toEqual([
      'activity-logs/2026/05/01/activity-00000000T000000000Z-legacy.jsonl',
      'activity-logs/2026/06/02/activity-00000000T000000000Z-legacy.jsonl',
    ]);
    expect(await Activity.countDocuments()).toBe(3);
    expect(await Migration.exists({ _id: 'activity-to-s3' })).toBeTruthy();

    const bodies = logKeys().map((k) => Buffer.from(s3.objects.get(k)!.body).toString());
    await activityService.flush(2000);
    expect(logKeys().map((k) => Buffer.from(s3.objects.get(k)!.body).toString())).toEqual(bodies);

    const { items } = await page('from=2026-05-01&to=2026-06-30');
    expect(items.map((e) => e.eventType)).toEqual(['FILE_DOWNLOADED', 'FILE_RENAMED', 'FILE_UPLOADED']);
    expect(items[1]!.details.previousName).toBe('old-a.pdf');
    expect(items[2]!.at).toBe('2026-05-01T08:00:00.000Z');
  });
});
