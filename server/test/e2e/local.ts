/**
 * Local run without AWS or a MongoDB install: the real API and built client on one origin
 * (http://localhost:4000), an embedded MongoDB, and S3 replaced by the in-memory fake. Unlike the
 * e2e harness, data is kept on disk in .local-data/ so it survives restarts. Presigned URLs point at
 * /__fake-s3 on the same server, so uploads and downloads work in any browser.
 *
 *   npm run build --workspace client && npm run local
 *
 * This verifies application behaviour only; it does not exercise real S3.
 */
import '../setup-env.js';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.LOCAL_PORT ?? 4000);
const ROOT = path.resolve(import.meta.dirname, '../../..');
const DATA = process.env.LOCAL_DATA ?? path.join(ROOT, '.local-data');
const MONGO_DIR = path.join(DATA, 'mongo');
const S3_DIR = path.join(DATA, 's3');
fs.mkdirSync(MONGO_DIR, { recursive: true });
fs.mkdirSync(S3_DIR, { recursive: true });

process.env.FRONTEND_URL = `http://localhost:${PORT}`;
process.env.AWS_S3_ENDPOINT = `http://localhost:${PORT}/__fake-s3`;
process.env.AWS_S3_FORCE_PATH_STYLE = 'true';
process.env.CLEANUP_INTERVAL_MINUTES = '15';

const { MongoMemoryServer } = await import('mongodb-memory-server');
const { default: express } = await import('express');
const { createFakeS3 } = await import('../helpers/fakeS3.js');
const { connectDb } = await import('../../src/lib/db.js');
const { createApp } = await import('../../src/app.js');
const { scheduleMaintenance } = await import('../../src/jobs/maintenance.js');

const mongo = await MongoMemoryServer.create({ instance: { dbPath: MONGO_DIR, storageEngine: 'wiredTiger', port: Number(process.env.LOCAL_MONGO_PORT ?? 27019) } });
await connectDb(mongo.getUri('cirrus_local'));

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

const app = express();
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
const api = createApp({ catchAll: false });
app.use((req, res, next) => (req.path.startsWith('/api') ? api(req, res, next) : next()));
const dist = process.env.LOCAL_DIST ?? path.join(ROOT, 'client/dist');
// Never cache the HTML shell, so a rebuilt client is picked up on the next page load.
app.use(express.static(dist, { setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); } }));
app.use((_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(dist, 'index.html'));
});
const stopJobs = scheduleMaintenance();

const server = app.listen(PORT, () => console.log(`Cirrus running on http://localhost:${PORT} (data in ${DATA})`));
const stop = async () => {
  stopJobs();
  server.close();
  await mongo.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
