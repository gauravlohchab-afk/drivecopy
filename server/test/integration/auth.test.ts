import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, app, signUp, ORIGIN } from '../helpers/app.js';
import { User, Session } from '../../src/models/index.js';

createFakeS3();
beforeAll(() => setupDb('auth'));
afterAll(teardownDb);

describe('authentication', () => {
  it('registers, sets an HTTP-only session cookie and returns the current user', async () => {
    const agent = request.agent(app());
    const res = await agent.post('/api/auth/register').set('Origin', ORIGIN).send({ name: 'Grace', email: 'Grace@Example.com', password: 'abcdefgh12' }).expect(201);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const session = cookies.find((c) => c.startsWith('dc_session='));
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(res.body.user).toMatchObject({ name: 'Grace', email: 'grace@example.com' });
    expect(res.body.user.passwordHash).toBeUndefined();

    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.user.email).toBe('grace@example.com');
  });

  it('stores an argon2id hash, never the plaintext password', async () => {
    const user = await User.findOne({ email: 'grace@example.com' }).select('+passwordHash').lean();
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user!.passwordHash).not.toContain('abcdefgh12');
  });

  it('stores only a hash of the session token', async () => {
    const sessions = await Session.find().lean();
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) expect(s.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects duplicate emails and weak passwords', async () => {
    await request(app()).post('/api/auth/register').set('Origin', ORIGIN).send({ name: 'G', email: 'grace@example.com', password: 'abcdefgh12' }).expect(409);
    const weak = await request(app()).post('/api/auth/register').set('Origin', ORIGIN).send({ name: 'G', email: 'new@example.com', password: 'short' }).expect(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('logs in with correct credentials and rejects wrong ones with a generic message', async () => {
    const ok = await request(app()).post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'grace@example.com', password: 'abcdefgh12' }).expect(200);
    expect(ok.body.csrfToken).toBeTruthy();
    const bad = await request(app()).post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'grace@example.com', password: 'nope-nope-1' }).expect(401);
    const unknown = await request(app()).post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'nobody@example.com', password: 'nope-nope-1' }).expect(401);
    expect(bad.body.error.message).toBe(unknown.body.error.message);
  });

  it('requires authentication for protected routes', async () => {
    await request(app()).get('/api/auth/me').expect(401);
    await request(app()).get('/api/folders/root/contents').expect(401);
    await request(app()).get('/api/auth/me').set('Cookie', 'dc_session=forged-token-value-forged-token-value').expect(401);
  });

  it('logout revokes the server-side session', async () => {
    const c = await signUp();
    await c.get('/api/auth/me').expect(200);
    await c.post('/api/auth/logout').expect(204);
    await c.get('/api/auth/me').expect(401);
  });

  it('enforces CSRF tokens on authenticated writes and rejects foreign origins', async () => {
    const c = await signUp();
    await c.agent.post('/api/folders').set('Origin', ORIGIN).send({ name: 'x' }).expect(403);
    await c.agent.post('/api/folders').set('Origin', ORIGIN).set('X-CSRF-Token', 'wrong').send({ name: 'x' }).expect(403);
    await c.agent.post('/api/folders').set('Origin', 'https://evil.example').set('X-CSRF-Token', c.csrf).send({ name: 'x' }).expect(403);
    await c.post('/api/folders', { name: 'x' }).expect(201);
  });

  it('changes password, keeps the current session and revokes others', async () => {
    const c = await signUp('Pat', 'pat@example.com');
    const other = request.agent(app());
    await other.post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'pat@example.com', password: 'correct horse 42' }).expect(200);
    await c.post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'newpassword99' }).expect(400);
    await c.post('/api/auth/password', { currentPassword: 'correct horse 42', newPassword: 'newpassword99' }).expect(204);
    await c.get('/api/auth/me').expect(200);
    await other.get('/api/auth/me').expect(401);
  });

  it('does not leak internals on malformed input', async () => {
    const res = await request(app()).post('/api/auth/login').set('Origin', ORIGIN).set('Content-Type', 'application/json').send('{bad json').expect(400);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at .*\.ts/);
  });
});
