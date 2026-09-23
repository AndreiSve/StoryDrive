import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const pbkdf2 = promisify(crypto.pbkdf2);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = positiveInteger(process.env.PORT, 8080);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = IS_PRODUCTION ? '__Host-storydrive_session' : 'storydrive_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_HASH_ITERATIONS = 210_000;
const FEED_PROCESSING_TIMEOUT_MS = 120_000;
const IMAGE_REQUEST_TIMEOUT_MS = 25_000;
const MAX_FEED_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_SIZE_BYTES = 25 * 1024 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: https://img.maxposter.ru https://*.maxposter.ru; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function databaseSsl() {
  const mode = String(process.env.DATABASE_SSL || '').toLowerCase();
  if (mode === 'disable' || mode === 'false') return false;
  const ca = process.env.DATABASE_CA_BASE64;
  if (ca) return { ca: Buffer.from(ca, 'base64').toString('utf8'), rejectUnauthorized: true };
  if (mode === 'require' || mode === 'true') return { rejectUnauthorized: false };
  return undefined;
}

function createPool() {
  if (!process.env.DATABASE_URL) throw new Error('Переменная DATABASE_URL не задана.');
  const ssl = databaseSsl();
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ...(ssl === undefined ? {} : { ssl }),
    max: positiveInteger(process.env.DATABASE_POOL_SIZE, 10),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

function normalizedEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 10 && value.length <= 128;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function passwordHash(password, saltHex) {
  const derived = await pbkdf2(password, Buffer.from(saltHex, 'hex'), PASSWORD_HASH_ITERATIONS, 32, 'sha256');
  return derived.toString('hex');
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieValue(req, name) {
  const cookieHeader = req.get('cookie') || '';
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

function setSessionCookie(res, token, maxAgeSeconds = SESSION_TTL_SECONDS) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.max(0, maxAgeSeconds) * 1000,
  });
}

function sameOrigin(req) {
  const origin = req.get('origin');
  const expected = `${req.protocol}://${req.get('host')}`;
  if (origin && origin !== expected) return false;
  return req.get('sec-fetch-site') !== 'cross-site';
}

function allowedMaxPosterUrl(value) {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return null;
    if (hostname !== 'maxposter.ru' && !hostname.endsWith('.maxposter.ru')) return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function apiError(res, message, status = 400) {
  return res.status(status).json({ error: message });
}

function publicUser(row) {
  return { id: row.id, email: row.email, plan: row.plan };
}

async function createSession(client, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  await client.query(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)',
    [sha256Hex(token), userId, now + SESSION_TTL_SECONDS, now],
  );
  return token;
}

async function currentSession(req, pool) {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = sha256Hex(token);
  const result = await pool.query(`
    SELECT u.id, u.email, u.plan, u.status, s.expires_at, f.feed_url
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN user_feeds f ON f.user_id = u.id
    WHERE s.token_hash = $1
  `, [tokenHash]);
  const row = result.rows[0];
  const now = Math.floor(Date.now() / 1000);
  if (!row || Number(row.expires_at) <= now || row.status !== 'active') {
    if (row) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    return null;
  }
  return { ...row, feedUrl: row.feed_url || '', tokenHash };
}

async function readLimitedResponseBody(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length')) || 0;
  if (declaredLength > maximumBytes) throw Object.assign(new Error('response_too_large'), { code: 'RESPONSE_TOO_LARGE' });
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw Object.assign(new Error('response_too_large'), { code: 'RESPONSE_TOO_LARGE' });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function proxyMaxPoster(req, res, targetValue, kind) {
  const target = allowedMaxPosterUrl(targetValue);
  if (!target) return res.status(400).type('text').send('Разрешены только HTTPS-ссылки на maxposter.ru.');
  const timeoutMs = kind === 'feed' ? FEED_PROCESSING_TIMEOUT_MS : IMAGE_REQUEST_TIMEOUT_MS;
  try {
    const upstream = await fetch(target, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: kind === 'image' ? 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' : 'application/xml,text/xml;q=0.9,*/*;q=0.5',
        'User-Agent': 'StoryDrive/1.0',
      },
    });
    if (!upstream.ok) return res.status(502).type('text').send(`MaxPoster вернул HTTP ${upstream.status}.`);
    const contentType = upstream.headers.get('content-type') || (kind === 'image' ? 'image/jpeg' : 'text/xml; charset=utf-8');
    if (kind === 'image' && !contentType.toLowerCase().startsWith('image/')) {
      return res.status(502).type('text').send('MaxPoster вернул данные, которые не являются изображением.');
    }
    if (kind === 'feed' && /^(?:text\/html|application\/(?:json|pdf)|image\/)/i.test(contentType)) {
      return res.status(502).type('text').send('MaxPoster вернул документ не в формате XML.');
    }

    const body = await readLimitedResponseBody(upstream, kind === 'feed' ? MAX_FEED_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES);
    if (kind === 'feed') {
      const prefix = body.subarray(0, Math.min(body.length, 4096)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
      if (!prefix.startsWith('<') || /^<(?:!doctype\s+html|html)\b/i.test(prefix) || !/<yml_catalog(?:\s|>)/i.test(prefix)) {
        return res.status(422).type('text').send('Неверный формат фида. Ожидается YML-документ MaxPoster.');
      }
    }
    res.set({
      'Content-Type': kind === 'feed' ? 'application/xml; charset=utf-8' : contentType,
      'Content-Length': String(body.length),
      'Cache-Control': kind === 'feed' ? 'no-store' : 'public, max-age=86400',
    });
    return res.status(200).send(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error?.code === 'RESPONSE_TOO_LARGE') {
      return res.status(413).type('text').send(kind === 'feed' ? 'Фид слишком большой. Максимум — 20 МБ.' : 'Изображение слишком большое.');
    }
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    console.error(JSON.stringify({ event: 'maxposter_proxy_error', kind, message: error?.message || 'Unknown error' }));
    return res.status(timedOut ? 504 : 502).type('text').send(
      timedOut
        ? (kind === 'feed' ? 'Обработка фида отменена: превышен лимит 2 минуты.' : 'Время загрузки изображения истекло.')
        : 'Не удалось получить данные от MaxPoster.',
    );
  }
}

async function runMigrations(pool) {
  const migration = await fs.readFile(path.join(ROOT_DIR, 'db', 'migrations', '001_auth.sql'), 'utf8');
  await pool.query(migration);
}

export async function createApp(pool) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.set(name, value);
    if (IS_PRODUCTION) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use('/api', express.json({ limit: '16kb', type: 'application/json' }));

  app.post('/api/auth/register', async (req, res) => {
    if (!sameOrigin(req)) return apiError(res, 'Запрос отклонён.', 403);
    const email = normalizedEmail(req.body?.email);
    const password = req.body?.password;
    if (!email) return apiError(res, 'Введите корректный email.');
    if (!validPassword(password)) return apiError(res, 'Пароль должен содержать от 10 до 128 символов.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userId = crypto.randomUUID();
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await passwordHash(password, salt);
      const now = Math.floor(Date.now() / 1000);
      await client.query(`
        INSERT INTO users (id, email, password_hash, password_salt, plan, status, created_at)
        VALUES ($1, $2, $3, $4, 'free', 'active', $5)
      `, [userId, email, hash, salt, now]);
      const token = await createSession(client, userId);
      await client.query('COMMIT');
      setSessionCookie(res, token);
      return res.status(201).json({ user: { id: userId, email, plan: 'free' }, feedUrl: '' });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error?.code === '23505') return apiError(res, 'Аккаунт с таким email уже существует.', 409);
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    if (!sameOrigin(req)) return apiError(res, 'Запрос отклонён.', 403);
    const email = normalizedEmail(req.body?.email);
    const password = req.body?.password;
    if (!email || !validPassword(password)) return apiError(res, 'Неверный email или пароль.', 401);
    const result = await pool.query(`
      SELECT u.id, u.email, u.password_hash, u.password_salt, u.plan, u.status, f.feed_url
      FROM users u LEFT JOIN user_feeds f ON f.user_id = u.id WHERE u.email = $1
    `, [email]);
    const user = result.rows[0];
    const salt = user?.password_salt || '00000000000000000000000000000000';
    const calculatedHash = await passwordHash(password, salt);
    if (!user || user.status !== 'active' || !constantTimeEqual(calculatedHash, user.password_hash)) {
      return apiError(res, 'Неверный email или пароль.', 401);
    }
    const token = await createSession(pool, user.id);
    setSessionCookie(res, token);
    return res.json({ user: publicUser(user), feedUrl: user.feed_url || '' });
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (!sameOrigin(req)) return apiError(res, 'Запрос отклонён.', 403);
    const token = cookieValue(req, SESSION_COOKIE);
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256Hex(token)]);
    setSessionCookie(res, '', 0);
    return res.json({ ok: true });
  });

  app.get('/api/auth/me', async (req, res) => {
    const session = await currentSession(req, pool);
    if (!session) return apiError(res, 'Требуется вход.', 401);
    return res.json({ user: publicUser(session), feedUrl: session.feedUrl });
  });

  app.use('/api', async (req, res, next) => {
    const session = await currentSession(req, pool);
    if (!session) return apiError(res, 'Требуется вход.', 401);
    req.storydriveUser = session;
    next();
  });

  async function handleFeed(req, res, persistUrl) {
    const requestedUrl = req.query.url || req.storydriveUser.feedUrl;
    if (!requestedUrl) return res.status(400).type('text').send('Сначала добавьте ссылку на XML-фид.');
    await proxyMaxPoster(req, res, String(requestedUrl), 'feed');
    if (persistUrl && res.statusCode >= 200 && res.statusCode < 300 && req.query.url) {
      await pool.query(`
        INSERT INTO user_feeds (user_id, feed_url, updated_at) VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE SET feed_url = EXCLUDED.feed_url, updated_at = EXCLUDED.updated_at
      `, [req.storydriveUser.id, String(requestedUrl), Math.floor(Date.now() / 1000)]);
    }
  }

  app.get('/api/feed', (req, res) => handleFeed(req, res, true));
  app.head('/api/feed', (req, res) => handleFeed(req, res, false));
  app.get('/api/image', (req, res) => proxyMaxPoster(req, res, String(req.query.url || ''), 'image'));
  app.head('/api/image', (req, res) => proxyMaxPoster(req, res, String(req.query.url || ''), 'image'));
  app.delete('/api/user/feed', async (req, res) => {
    if (!sameOrigin(req)) return apiError(res, 'Запрос отклонён.', 403);
    await pool.query('DELETE FROM user_feeds WHERE user_id = $1', [req.storydriveUser.id]);
    return res.json({ ok: true });
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'storydrive' }));
  app.get('/ready', async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  });
  const sendPublicFile = (name, contentType) => (req, res) => {
    res.set({ 'Cache-Control': 'no-cache', 'Content-Type': contentType });
    res.sendFile(path.join(ROOT_DIR, name));
  };
  app.get(['/', '/index.html'], sendPublicFile('index.html', 'text/html; charset=utf-8'));
  app.get('/styles.css', sendPublicFile('styles.css', 'text/css; charset=utf-8'));
  app.get('/app.js', sendPublicFile('app.js', 'text/javascript; charset=utf-8'));
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.use((req, res) => res.status(404).type('text').send('Not found.'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error(JSON.stringify({ event: 'request_failed', path: req.path, message: error?.message || 'Unknown error' }));
    if (error?.type === 'entity.too.large') return apiError(res, 'Запрос слишком большой.', 413);
    return req.path.startsWith('/api/')
      ? apiError(res, 'Внутренняя ошибка сервера.', 500)
      : res.status(500).type('text').send('Internal server error.');
  });
  return app;
}

async function main() {
  const pool = createPool();
  pool.on('error', (error) => console.error(JSON.stringify({ event: 'postgres_pool_error', message: error.message })));
  await runMigrations(pool);
  await pool.query('DELETE FROM sessions WHERE expires_at <= $1', [Math.floor(Date.now() / 1000)]);
  const app = await createApp(pool);
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`StoryDrive listening on 0.0.0.0:${PORT}`));

  const shutdown = () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'startup_failed', message: error.message }));
    process.exit(1);
  });
}
