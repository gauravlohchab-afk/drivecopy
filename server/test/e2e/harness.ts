/**
 * Local end-to-end harness: the real API + built client on one origin, with S3 replaced by the
 * in-memory fake. Browser uploads/downloads to the presigned S3 URLs are redirected (by the
 * browser automation) to /__fake-s3, so the full UI flow runs without AWS credentials.
 * This verifies application behaviour only; it does not verify real S3 configuration.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27017/drivecopy_e2e npx tsx test/e2e/harness.ts
 */
import '../setup-env.js';
process.env.FRONTEND_URL = 'http://localhost:4000';
process.env.MULTIPART_THRESHOLD_MB = '6';
process.env.MULTIPART_PART_SIZE_MB = '5';
process.env.MONGODB_URI = process.env.E2E_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/drivecopy_e2e';

const { default: express } = await import('express');
const path = await import('node:path');
const { createFakeS3 } = await import('../helpers/fakeS3.js');
const { connectDb } = await import('../../src/lib/db.js');
const { createApp } = await import('../../src/app.js');
const mongoose = (await import('mongoose')).default;

const s3 = createFakeS3();
await connectDb(process.env.MONGODB_URI, { syncIndexes: false });
await mongoose.connection.db!.dropDatabase();
for (const model of Object.values(mongoose.models)) {
  for (const [fields, options] of model.schema.indexes()) {
    if ((options as { expireAfterSeconds?: number })?.expireAfterSeconds !== undefined) continue;
    await model.collection.createIndex(fields as Record<string, 1>, options as Record<string, unknown>);
  }
}

const outer = express();
outer.all('/__fake-s3/{*key}', express.raw({ type: () => true, limit: '200mb' }), (req, res) => {
  const key = decodeURIComponent(req.path.replace(/^\/__fake-s3\//, '')).replace(/^drivecopy-test-bucket\//, '');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'ETag');
  if (req.method === 'PUT') {
    const body = new Uint8Array(req.body as Buffer);
    if (req.query.uploadId) {
      const etag = s3.putPart(String(req.query.uploadId), Number(req.query.partNumber), body);
      res.setHeader('ETag', etag);
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
outer.use((req, res, next) => (req.path.startsWith('/api') ? api(req, res, next) : next()));
const dist = path.resolve(import.meta.dirname, '../../../client/dist');
outer.use(express.static(dist));
outer.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
outer.listen(4000, () => console.log('e2e harness on http://localhost:4000'));
