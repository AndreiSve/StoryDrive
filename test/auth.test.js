import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../server/index.js';

function memoryPool() {
  const users = new Map();
  const sessions = new Map();
  const feeds = new Map();

  async function query(sql, params = []) {
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(compact)) return { rows: [] };
    if (compact.startsWith('INSERT INTO users')) {
      if ([...users.values()].some((user) => user.email === params[1])) {
        throw Object.assign(new Error('duplicate email'), { code: '23505' });
      }
      const user = {
        id: params[0], email: params[1], password_hash: params[2], password_salt: params[3],
        plan: 'free', status: 'active', created_at: params[4],
      };
      users.set(user.id, user);
      return { rows: [] };
    }
    if (compact.startsWith('INSERT INTO sessions')) {
      sessions.set(params[0], { token_hash: params[0], user_id: params[1], expires_at: params[2], created_at: params[3] });
      return { rows: [] };
    }
    if (compact.includes('WHERE u.email = $1')) {
      const user = [...users.values()].find((candidate) => candidate.email === params[0]);
      return { rows: user ? [{ ...user, feed_url: feeds.get(user.id) || null }] : [] };
    }
    if (compact.includes('WHERE s.token_hash = $1')) {
      const session = sessions.get(params[0]);
      const user = session && users.get(session.user_id);
      return { rows: user ? [{ ...user, expires_at: session.expires_at, feed_url: feeds.get(user.id) || null }] : [] };
    }
    if (compact.startsWith('DELETE FROM sessions WHERE token_hash')) {
      sessions.delete(params[0]);
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${compact}`);
  }

  return { query, async connect() { return { query, release() {} }; } };
}

let server;
let baseUrl;

before(async () => {
  const app = await createApp(memoryPool());
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test('registration creates a session that can be inspected and closed', async () => {
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'Owner@Example.com', password: 'safe-password-123' }),
  });
  assert.equal(registration.status, 201);
  const payload = await registration.json();
  assert.equal(payload.user.email, 'owner@example.com');
  assert.equal(payload.user.plan, 'free');
  assert.equal(payload.feedUrl, '');

  const cookie = registration.headers.get('set-cookie').split(';', 1)[0];
  assert.match(cookie, /^storydrive_session=[a-f0-9]{64}$/);

  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, 'owner@example.com');

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);

  const expired = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(expired.status, 401);
});

test('login rejects an incorrect password and accepts the correct one', async () => {
  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: 'wrong-password' }),
  });
  assert.equal(badLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: 'safe-password-123' }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
});
