import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { connectDb } from '../../src/lib/db.js';
import { User } from '../../src/models/index.js';
import { createSession, resetLoginGuard } from '../../src/services/auth.service.js';
import { ensureAdminAccount } from '../../src/services/admin.service.js';

export const ORIGIN = 'http://localhost:5173';

export async function setupDb(name: string) {
  const base = process.env.MONGODB_URI!;
  const url = new URL(base);
  url.pathname = `/drivecopy_test_${name}`;
  await connectDb(url.toString(), { syncIndexes: false });
  await mongoose.connection.db!.dropDatabase();
  await createIndexes();
}

/**
 * Creates every schema index. When the test database is FerretDB (used where a real mongod is not
 * available), TTL options are not supported; those indexes are skipped and listed. All unique
 * indexes, which correctness depends on, must succeed.
 */
async function createIndexes() {
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection().catch(() => undefined);
    for (const [fields, options] of model.schema.indexes()) {
      try {
        await model.collection.createIndex(fields as Record<string, 1 | -1>, options as Record<string, unknown>);
      } catch (err) {
        const msg = (err as Error).message;
        if (options?.expireAfterSeconds !== undefined && /not implemented/i.test(msg)) {
          skippedIndexes.push(`${model.modelName} ${JSON.stringify(fields)} (TTL)`);
          continue;
        }
        throw err;
      }
    }
  }
}
export const skippedIndexes: string[] = [];

export async function teardownDb() {
  await mongoose.connection.db?.dropDatabase();
  await mongoose.disconnect();
}

export const app = () => createApp();

/**
 * A user that exists in the database with a live session. The API has no way to create accounts, so
 * this is how tests set up the owner, sharing and shared-drive rules that the services still enforce.
 */
export async function signUp(name = 'Ada', email = `user${Math.random().toString(36).slice(2, 8)}@example.com`) {
  const user = await User.create({ name, email, passwordHash: '!test' });
  const session = await createSession(user._id);
  const agent = request.agent(app());
  agent.set('Cookie', `dc_session=${session.token}`);
  return client(agent, session.csrfToken, { id: String(user._id), email: user.email }, email);
}

/** Signs in through the real login endpoint, creating the admin account first if needed. */
export async function signInAsAdmin() {
  await ensureAdminAccount();
  resetLoginGuard();
  const agent = request.agent(app());
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ username: env.ADMIN_LOGIN_USERNAME, password: env.ADMIN_LOGIN_PASSWORD })
    .expect(200);
  return client(agent, res.body.csrfToken as string, res.body.user as { id: string; email: string }, res.body.user.email as string);
}

type Agent = ReturnType<typeof request.agent>;

/** Test user agent holding its own cookie jar and CSRF token, like a browser tab. */
function client(agent: Agent, csrf: string, user: { id: string; email: string }, email: string) {
  const send = (method: 'post' | 'patch' | 'delete', path: string, body?: object) =>
    agent[method](path).set('Origin', ORIGIN).set('X-CSRF-Token', csrf).send(body ?? {});
  return {
    agent,
    csrf,
    user,
    email,
    get: (path: string) => agent.get(path),
    post: (path: string, body?: object) => send('post', path, body),
    patch: (path: string, body?: object) => send('patch', path, body),
    del: (path: string) => send('delete', path),
  };
}
export type Client = ReturnType<typeof client>;

export const pdfBytes = (size = 1000) => {
  const b = Buffer.alloc(size, 0x20);
  b.write('%PDF-1.7\n');
  return b;
};
export const pngBytes = (size = 500) => {
  const b = Buffer.alloc(size, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b;
};

/** Runs the whole upload flow (initiate, simulated browser PUT, server verification). */
export async function uploadFile(
  c: Client,
  s3: { putObject: (k: string, b: Uint8Array) => void },
  name: string,
  body: Uint8Array,
  parentFolderId: string | null = null,
) {
  const { UploadSession } = await import('../../src/models/index.js');
  const init = await c.post('/api/uploads/initiate', { name, size: body.byteLength, parentFolderId }).expect(201);
  const session = await UploadSession.findById(init.body.uploadId).lean();
  s3.putObject(session!.s3Key, body);
  const done = await c.post(`/api/uploads/${init.body.uploadId}/complete`).expect(200);
  return { ...done.body.file, s3Key: session!.s3Key } as { id: string; name: string; size: number; s3Key: string };
}
