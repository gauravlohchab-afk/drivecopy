/**
 * Local run without installing MongoDB: the real API and built client on one origin
 * (http://localhost:4000) with an embedded MongoDB whose data is kept in .local-data/.
 *
 *   npm run build --workspace frontend && npm run local
 *
 * Storage:
 * - Real Amazon S3 when backend/.env sets AWS_S3_BUCKET (plus AWS_REGION and, unless an IAM role or
 *   profile is used, AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY). The bucket must allow this origin
 *   in its CORS rules; see docs/DEPLOYMENT.md. Access is checked at startup.
 * - Otherwise (or with LOCAL_S3=fake) an in-process fake S3 mirrored to .local-data/s3, so uploads
 *   and downloads still work in any browser. That mode verifies app behaviour, not AWS setup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse } from 'dotenv';

const PORT = Number(process.env.LOCAL_PORT ?? 4000);
const ROOT = path.resolve(import.meta.dirname, '../../..');
const DATA = process.env.LOCAL_DATA ?? path.join(ROOT, '.local-data');
const MONGO_DIR = path.join(DATA, 'mongo');
const S3_DIR = path.join(DATA, 's3');
fs.mkdirSync(MONGO_DIR, { recursive: true });
fs.mkdirSync(S3_DIR, { recursive: true });

const envFile = process.env.LOCAL_ENV_FILE ?? path.join(ROOT, 'backend/.env');
const fileEnv = fs.existsSync(envFile) ? parse(fs.readFileSync(envFile)) : {};
const realS3 = Boolean(fileEnv.AWS_S3_BUCKET) && process.env.LOCAL_S3 !== 'fake';

if (realS3) {
  for (const [k, v] of Object.entries(fileEnv)) if (process.env[k] === undefined) process.env[k] = v;
  process.env.NODE_ENV ??= 'development';
  // A stable secret keeps sessions valid across restarts; generated once, never committed.
  const secretFile = path.join(DATA, 'session-secret');
  if (!process.env.SESSION_SECRET) {
    if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, randomBytes(48).toString('base64url'));
    process.env.SESSION_SECRET = fs.readFileSync(secretFile, 'utf8').trim();
  }
} else {
  // Fake storage still uses the configured login, when there is one.
  for (const k of ['ADMIN_LOGIN_USERNAME', 'ADMIN_LOGIN_PASSWORD']) if (fileEnv[k] && process.env[k] === undefined) process.env[k] = fileEnv[k];
  await import('../setup-env.js');
  process.env.AWS_S3_ENDPOINT = `http://localhost:${PORT}/__fake-s3`;
  process.env.AWS_S3_FORCE_PATH_STYLE = 'true';
  process.env.CLEANUP_INTERVAL_MINUTES = '15';
}
process.env.FRONTEND_URL = `http://localhost:${PORT}`;

const { MongoMemoryServer } = await import('mongodb-memory-server');
const mongo = await MongoMemoryServer.create({ instance: { dbPath: MONGO_DIR, storageEngine: 'wiredTiger', port: Number(process.env.LOCAL_MONGO_PORT ?? 27019) } });
// Database name predates the Ageless Datahub name; kept so existing local data still loads.
process.env.MONGODB_URI = mongo.getUri('cirrus_local');

const { default: express } = await import('express');
const { connectDb } = await import('../../src/lib/db.js');
const { createApp } = await import('../../src/app.js');
const { scheduleMaintenance } = await import('../../src/jobs/maintenance.js');
await connectDb(process.env.MONGODB_URI);

const app = express();

if (realS3) {
  const { s3 } = await import('../../src/services/s3.service.js');
  const { ListObjectsV2Command, HeadObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const Bucket = process.env.AWS_S3_BUCKET!;

  // Fail fast with a clear message instead of failing on the first upload.
  try {
    await s3.send(new ListObjectsV2Command({ Bucket, Prefix: 'users/', MaxKeys: 1 }));
  } catch (err) {
    const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    const hint: Record<string, string> = {
      CredentialsProviderError: 'No AWS credentials found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in backend/.env.',
      InvalidAccessKeyId: 'AWS_ACCESS_KEY_ID is not a valid access key.',
      SignatureDoesNotMatch: 'AWS_SECRET_ACCESS_KEY does not match the access key.',
      AccessDenied: 'The key works but is not allowed to list the bucket. Attach the IAM policy from docs/DEPLOYMENT.md.',
      NoSuchBucket: `Bucket "${Bucket}" does not exist. Check AWS_S3_BUCKET.`,
      PermanentRedirect: `Bucket "${Bucket}" is in a different region. Set AWS_REGION to the bucket's region.`,
      AuthorizationHeaderMalformed: `Wrong region for "${Bucket}". Set AWS_REGION to the bucket's region.`,
    };
    const status = e.$metadata?.httpStatusCode;
    console.error(`\nCannot use S3 bucket "${Bucket}" (${process.env.AWS_REGION}): ${e.name ?? 'Error'}${status ? ` ${status}` : ''}`);
    console.error(hint[e.name ?? ''] ?? (status === 301 ? hint.PermanentRedirect : e.message));
    console.error('Fix backend/.env and start again, or run with LOCAL_S3=fake to use the built-in fake storage.\n');
    await mongo.stop({ doCleanup: false });
    process.exit(1);
  }

  // One-time copy of files uploaded earlier in fake-storage mode, so their records keep working.
  const marker = path.join(DATA, `s3-copied-to-${Bucket}.json`);
  const done = new Set<string>(fs.existsSync(marker) ? (JSON.parse(fs.readFileSync(marker, 'utf8')) as string[]) : []);
  const pending = fs.readdirSync(S3_DIR).map((n) => ({ name: n, key: decodeURIComponent(n) })).filter((f) => f.key.startsWith('users/') && !done.has(f.key));
  if (pending.length) console.log(`Copying ${pending.length} file(s) from local storage to s3://${Bucket} …`);
  for (const f of pending) {
    const exists = await s3.send(new HeadObjectCommand({ Bucket, Key: f.key })).then(() => true, () => false);
    if (!exists) await s3.send(new PutObjectCommand({ Bucket, Key: f.key, Body: fs.readFileSync(path.join(S3_DIR, f.name)) }));
    done.add(f.key);
    fs.writeFileSync(marker, JSON.stringify([...done]));
  }
} else {
  const { createFakeS3 } = await import('../helpers/fakeS3.js');
  // Mirror the fake bucket to disk: one file per object, named by the encoded key.
  const s3 = createFakeS3();
  const fileFor = (key: string) => path.join(S3_DIR, encodeURIComponent(key));
  for (const name of fs.readdirSync(S3_DIR)) {
    const full = path.join(S3_DIR, name);
    s3.objects.set(decodeURIComponent(name), { body: new Uint8Array(fs.readFileSync(full)), lastModified: fs.statSync(full).mtime });
  }
  const set = s3.objects.set.bind(s3.objects);
  const del = s3.objects.delete.bind(s3.objects);
  s3.objects.set = (key, value) => {
    fs.writeFileSync(fileFor(key), value.body);
    return set(key, value);
  };
  s3.objects.delete = (key) => {
    fs.rmSync(fileFor(key), { force: true });
    return del(key);
  };

  app.all('/__fake-s3/{*key}', express.raw({ type: () => true, limit: '200mb' }), (req, res) => {
    const key = decodeURIComponent(req.path.replace(/^\/__fake-s3\//, '')).replace(/^drivecopy-test-bucket\//, '');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'ETag');
    if (req.method === 'PUT') {
      const body = new Uint8Array(req.body as Buffer);
      if (req.query.uploadId) {
        res.setHeader('ETag', s3.putPart(String(req.query.uploadId), Number(req.query.partNumber), body));
      } else {
        s3.putObject(key, body);
        res.setHeader('ETag', '"ok"');
      }
      return res.status(200).end();
    }
    if (req.method === 'GET') {
      const o = s3.objects.get(key);
      if (!o) return res.status(404).end();
      const ct = req.query['response-content-type'];
      const cd = req.query['response-content-disposition'];
      if (typeof ct === 'string') res.setHeader('Content-Type', ct);
      if (typeof cd === 'string') res.setHeader('Content-Disposition', cd);
      return res.end(Buffer.from(o.body));
    }
    res.status(405).end();
  });
}

const api = createApp({ catchAll: false });
app.use((req, res, next) => (req.path.startsWith('/api') ? api(req, res, next) : next()));
const dist = process.env.LOCAL_DIST ?? path.join(ROOT, 'frontend/dist');
// Never cache the HTML shell, so a rebuilt client is picked up on the next page load.
app.use(express.static(dist, { setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); } }));
app.use((_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(dist, 'index.html'));
});
const { ensureAdminAccount } = await import('../../src/services/admin.service.js');
const { activityService } = await import('../../src/services/activity.service.js');
const { s3StatsService } = await import('../../src/services/s3Stats.service.js');
const { s3LayoutService } = await import('../../src/services/s3Layout.service.js');
await ensureAdminAccount();
const stopJobs = scheduleMaintenance();
const stopActivity = activityService.startFlusher();
const stopStats = s3StatsService.startScheduler();
const stopLayout = s3LayoutService.startJob();

const storage = realS3 ? `Amazon S3 bucket ${process.env.AWS_S3_BUCKET} (${process.env.AWS_REGION})` : 'built-in fake S3';
const server = app.listen(PORT, (err) => {
  // Express reports a failure to bind (such as a port in use) through this callback.
  if (err) throw err;
  console.log(`Ageless Datahub running on http://localhost:${PORT} (data in ${DATA}, files in ${storage})`);
});
const stop = async () => {
  stopJobs();
  stopActivity();
  stopStats();
  stopLayout();
  server.close();
  await activityService.flush().catch(() => undefined); // Anything unwritten stays in the outbox.
  await mongo.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
