import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../server/index.js';

const pool = {
  async query() {
    throw new Error('Unexpected database query in smoke test');
  },
};

let server;
let baseUrl;

before(async () => {
  const app = await createApp(pool);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test('health endpoint is available without authentication', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'storydrive' });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('application shell is served, private project files are not', async () => {
  const indexResponse = await fetch(`${baseUrl}/`);
  assert.equal(indexResponse.status, 200);
  assert.match(await indexResponse.text(), /StoryDrive/);

  const packageResponse = await fetch(`${baseUrl}/package.json`);
  assert.equal(packageResponse.status, 404);
});

test('authenticated API rejects a request without a session', async () => {
  const response = await fetch(`${baseUrl}/api/feed`);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Требуется вход.' });
});
