import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createFakeS3 } from '../helpers/fakeS3.js';
import { setupDb, teardownDb, app, signInAsAdmin, ORIGIN } from '../helpers/app.js';
import { env } from '../../src/config/env.js';
import { User, Session } from '../../src/models/index.js';
import { ensureAdminAccount } from '../../src/services/admin.service.js';
import { resetLoginGuard } from '../../src/services/auth.service.js';

createFakeS3();
beforeAll(async () => {
  await setupDb('auth');
  await ensureAdminAccount();
});
beforeEach(resetLoginGuard);
afterAll(teardownDb);

const USERNAME = env.ADMIN_LOGIN_USERNAME;
const PASSWORD = env.ADMIN_LOGIN_PASSWORD;
const login = (username: string, password: string, agent = request(app())) =>
  agent.post('/api/auth/login').set('Origin', ORIGIN).send({ username, password });

describe('single admin login', () => {
  it('has no registration: the endpoint is gone and creates nothing', async () => {
    const before = await User.countDocuments();
    await request(app()).post('/api/auth/register').set('Origin', ORIGIN).send({ name: 'G', email: 'new@example.com', password: 'abcdefgh1234' }).expect(401);
    expect(await User.countDocuments()).toBe(before);
    expect(await User.exists({ email: 'new@example.com' })).toBeNull();
  });

  it('signs in with the environment credentials and sets a protected session cookie', async () => {
    const agent = request.agent(app());
    const res = await login(USERNAME, PASSWORD, agent as never).expect(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const session = cookies.find((c) => c.startsWith('dc_session='));
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(res.body.csrfToken).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect(res.body.user.passwordHash).toBeUndefined();
    expect((await agent.get('/api/auth/me').expect(200)).body.user.email).toBe(USERNAME);
  });

  it('accepts the username in any letter case, but the password only exactly', async () => {
    await login(USERNAME.toUpperCase(), PASSWORD).expect(200);
    await login(USERNAME, PASSWORD.toUpperCase()).expect(401);
  });

  it('rejects wrong credentials with the same generic message', async () => {
    const badPassword = await login(USERNAME, 'not-the-password').expect(401);
    const badUsername = await login('somebody-else', PASSWORD).expect(401);
    expect(badPassword.body.error.message).toBe(badUsername.body.error.message);
    expect(badPassword.headers['set-cookie']).toBeUndefined();
  });

  it('stores an argon2id hash, never the plaintext password', async () => {
    const user = await User.findOne({ role: 'admin' }).select('+passwordHash').lean();
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user!.passwordHash).not.toContain(PASSWORD);
  });

  it('stores only a hash of the session token', async () => {
    const sessions = await Session.find().lean();
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) expect(s.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('pauses all logins after repeated failures, even with the right password', async () => {
    for (let i = 0; i < 20; i++) await login(USERNAME, `wrong-${i}`).expect(401);
    const locked = await login(USERNAME, PASSWORD).expect(429);
    expect(locked.body.error.code).toBe('RATE_LIMITED');
    resetLoginGuard();
    await login(USERNAME, PASSWORD).expect(200);
  });

  it('a successful login clears the failure count', async () => {
    for (let i = 0; i < 15; i++) await login(USERNAME, `wrong-${i}`).expect(401);
    await login(USERNAME, PASSWORD).expect(200);
    for (let i = 0; i < 15; i++) await login(USERNAME, `wrong-${i}`).expect(401);
    await login(USERNAME, PASSWORD).expect(200);
  });

  it('requires authentication for protected routes', async () => {
    await request(app()).get('/api/auth/me').expect(401);
    await request(app()).get('/api/folders/root/contents').expect(401);
    await request(app()).get('/api/activity').expect(401);
    await request(app()).get('/api/storage/s3').expect(401);
    await request(app()).get('/api/auth/me').set('Cookie', 'dc_session=forged-token-value-forged-token-value').expect(401);
  });

  it('logout revokes the server-side session', async () => {
    const c = await signInAsAdmin();
    await c.get('/api/auth/me').expect(200);
    await c.post('/api/auth/logout').expect(204);
    await c.get('/api/auth/me').expect(401);
  });

  it('enforces CSRF tokens on authenticated writes and rejects foreign origins', async () => {
    const c = await signInAsAdmin();
    await c.agent.post('/api/folders').set('Origin', ORIGIN).send({ name: 'x' }).expect(403);
    await c.agent.post('/api/folders').set('Origin', ORIGIN).set('X-CSRF-Token', 'wrong').send({ name: 'x' }).expect(403);
    await c.agent.post('/api/folders').set('Origin', 'https://evil.example').set('X-CSRF-Token', c.csrf).send({ name: 'x' }).expect(403);
    await c.post('/api/folders', { name: 'x' }).expect(201);
  });

  it('has no password change endpoint: the password is only set in the environment', async () => {
    const c = await signInAsAdmin();
    await c.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'another-password-99' }).expect(404);
    await login(USERNAME, PASSWORD).expect(200);
  });

  it('does not leak internals on malformed input', async () => {
    const res = await request(app()).post('/api/auth/login').set('Origin', ORIGIN).set('Content-Type', 'application/json').send('{bad json').expect(400);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at .*\.ts/);
  });
});

describe('changing the credentials in the environment (applies on restart)', () => {
  it('uses a new password after a restart and signs out sessions from the old one', async () => {
    const before = await signInAsAdmin();
    env.ADMIN_LOGIN_PASSWORD = 'a-brand-new-password-77';
    try {
      await ensureAdminAccount(); // What a restart runs.
      await before.get('/api/auth/me').expect(401);
      await login(USERNAME, PASSWORD).expect(401);
      await login(USERNAME, 'a-brand-new-password-77').expect(200);
    } finally {
      env.ADMIN_LOGIN_PASSWORD = PASSWORD;
      await ensureAdminAccount();
    }
    await login(USERNAME, PASSWORD).expect(200);
  });

  it('keeps sessions when a restart changes nothing', async () => {
    const c = await signInAsAdmin();
    await ensureAdminAccount();
    await c.get('/api/auth/me').expect(200);
  });

  it('renames the same admin account when the username changes', async () => {
    const id = (await User.findOne({ role: 'admin' }).lean())!._id;
    env.ADMIN_LOGIN_USERNAME = 'root-user';
    try {
      await ensureAdminAccount();
      await login('root-user', PASSWORD).expect(200);
      await login(USERNAME, PASSWORD).expect(401);
      const admins = await User.find({ role: 'admin' }).lean();
      expect(admins.map((a) => String(a._id))).toEqual([String(id)]);
    } finally {
      env.ADMIN_LOGIN_USERNAME = USERNAME;
      await ensureAdminAccount();
    }
  });
});
