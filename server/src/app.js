'use strict';
const crypto = require('crypto');
const express = require('express');
const { renderPuzzle } = require('./scene');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function angDiff(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}

function createApp(opts = {}) {
  const cfg = {
    secret: opts.secret || process.env.CAPTCHA_SECRET,
    allowedOrigins: (opts.allowedOrigins || process.env.ALLOWED_ORIGINS || 'https://op-era.github.io')
      .toString().split(',').map((s) => s.trim()).filter(Boolean),
    yesUrl: opts.yesUrl || process.env.YES_URL || 'https://onlyfans.com/esmeaura',
    toleranceDeg: opts.toleranceDeg ?? 8,
    challengeTtlMs: opts.challengeTtlMs ?? 2 * 60 * 1000,
    tokenTtlMs: opts.tokenTtlMs ?? 5 * 60 * 1000,
    minSolveMs: opts.minSolveMs ?? 1500,
    minMoves: opts.minMoves ?? 4,
    rateLimit: opts.rateLimit ?? { windowMs: 60 * 1000, challenge: 20, verify: 20, gate: 40 },
    maxFails: opts.maxFails ?? 3,
    lockoutMs: opts.lockoutMs ?? 5 * 60 * 1000,
    maxPending: opts.maxPending ?? 3000,
    trustFlyHeader: opts.trustFlyHeader ?? !!process.env.FLY_APP_NAME,
  };
  if (!cfg.secret || String(cfg.secret).length < 32) {
    throw new Error('CAPTCHA_SECRET must be set (>= 32 chars)');
  }

  /** @type {Map<string, {offset:number, answer:number, issuedAt:number, expiresAt:number, ip:string}>} */
  const challenges = new Map();
  const hits = new Map(); // `${bucket}:${ip}` -> number[]
  const fails = new Map(); // ip -> { count, lockedUntil }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.locals.challenges = challenges; // exposed for tests only
  app.locals.cfg = cfg;
  app.locals.fails = fails; // exposed for tests only

  const clientIp = (req) => (cfg.trustFlyHeader && req.headers['fly-client-ip']) || req.ip || 'unknown';

  // --- CORS (explicit allow-list) ---
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && cfg.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  // --- rate limiting (sliding window per IP per bucket) ---
  const limit = (bucket) => (req, res, next) => {
    const now = Date.now();
    const key = `${bucket}:${clientIp(req)}`;
    const arr = (hits.get(key) || []).filter((t) => now - t < cfg.rateLimit.windowMs);
    if (arr.length >= cfg.rateLimit[bucket]) {
      res.setHeader('Retry-After', Math.ceil(cfg.rateLimit.windowMs / 1000));
      return res.status(429).json({ error: 'rate_limited' });
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };

  // --- failed-attempt lockout: N consecutive failed answers from one IP -> blocked for lockoutMs ---
  const retryAfterSec = (rec) => Math.max(1, Math.ceil((rec.lockedUntil - Date.now()) / 1000));
  const lockCheck = (req, res, next) => {
    const rec = fails.get(clientIp(req));
    if (rec && rec.lockedUntil > Date.now()) {
      const ra = retryAfterSec(rec);
      res.setHeader('Retry-After', ra);
      return res.status(429).json({ ok: false, error: 'locked', retryAfterSec: ra });
    }
    next();
  };
  // returns the lockout response body if this failure triggered a lock, else null
  const registerFail = (ip) => {
    const now = Date.now();
    let rec = fails.get(ip);
    if (!rec || (rec.lockedUntil && rec.lockedUntil <= now)) rec = { count: 0, lockedUntil: 0 };
    rec.count += 1;
    if (rec.count >= cfg.maxFails) rec.lockedUntil = now + cfg.lockoutMs;
    fails.set(ip, rec);
    return rec.lockedUntil > now ? { ok: false, error: 'locked', retryAfterSec: retryAfterSec(rec) } : null;
  };
  const failResponse = (req, res, error) => {
    const locked = registerFail(clientIp(req));
    if (locked) {
      res.setHeader('Retry-After', locked.retryAfterSec);
      return res.status(429).json(locked);
    }
    return res.status(error === 'wrong_angle' ? 200 : 400).json({ ok: false, error });
  };

  const sign = (payload) => {
    const body = b64u(JSON.stringify(payload));
    const mac = crypto.createHmac('sha256', cfg.secret).update(body).digest();
    return `${body}.${b64u(mac)}`;
  };
  const unsign = (token) => {
    if (typeof token !== 'string' || token.length > 600) return null;
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expect = crypto.createHmac('sha256', cfg.secret).update(body).digest();
    let got;
    try { got = Buffer.from(mac, 'base64url'); } catch { return null; }
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (!p || typeof p.exp !== 'number' || Date.now() > p.exp) return null;
      return p;
    } catch { return null; }
  };

  const sweep = () => {
    const now = Date.now();
    for (const [id, c] of challenges) if (c.expiresAt < now) challenges.delete(id);
    for (const [ip, rec] of fails) if (rec.lockedUntil && rec.lockedUntil <= now) fails.delete(ip);
    for (const [k, arr] of hits) {
      const f = arr.filter((t) => now - t < cfg.rateLimit.windowMs);
      if (f.length) hits.set(k, f); else hits.delete(k);
    }
  };
  const timer = setInterval(sweep, 15 * 1000);
  timer.unref();
  app.locals.stop = () => clearInterval(timer);

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // --- GET /challenge ---
  app.get('/challenge', lockCheck, limit('challenge'), async (req, res) => {
    sweep();
    if (challenges.size >= cfg.maxPending) return res.status(503).json({ error: 'busy' });
    try {
      // inner disc is rotated clockwise by `offset`; user must rotate it clockwise by 360-offset
      const offset = 40 + crypto.randomInt(0, 28000) / 100; // 40.00 .. 319.99
      const answer = (360 - offset) % 360;
      const { outer, inner, size, innerSize } = await renderPuzzle(offset);
      const id = crypto.randomBytes(18).toString('base64url');
      const now = Date.now();
      challenges.set(id, { offset, answer, issuedAt: now, expiresAt: now + cfg.challengeTtlMs, ip: clientIp(req) });
      res.json({
        id,
        expiresInMs: cfg.challengeTtlMs,
        size,
        innerSize,
        outer: `data:image/webp;base64,${outer.toString('base64')}`,
        inner: `data:image/webp;base64,${inner.toString('base64')}`,
      });
    } catch (e) {
      console.error('challenge render failed', e.message);
      res.status(500).json({ error: 'render_failed' });
    }
  });

  // --- POST /verify ---
  app.post('/verify', lockCheck, limit('verify'), (req, res) => {
    const { id, angle, moves } = req.body || {};
    if (typeof id !== 'string' || id.length > 64 || typeof angle !== 'number' || !Number.isFinite(angle)) {
      return res.status(400).json({ error: 'bad_request' });
    }
    const c = challenges.get(id);
    if (!c) return res.status(400).json({ ok: false, error: 'unknown_or_used' });
    challenges.delete(id); // one attempt per challenge, success or fail
    const now = Date.now();
    if (now > c.expiresAt) return res.status(400).json({ ok: false, error: 'expired' });

    // behaviour checks
    if (now - c.issuedAt < cfg.minSolveMs) return failResponse(req, res, 'too_fast');
    if (!Array.isArray(moves) || moves.length < cfg.minMoves || moves.length > 2000) {
      return failResponse(req, res, 'no_interaction');
    }
    let prevT = -1; const distinct = new Set(); let valid = true;
    for (const m of moves) {
      if (!Array.isArray(m) || m.length !== 2 || !Number.isFinite(m[0]) || !Number.isFinite(m[1]) || m[0] < prevT) { valid = false; break; }
      prevT = m[0]; distinct.add(Math.round(m[1]));
    }
    if (!valid || distinct.size < cfg.minMoves) return failResponse(req, res, 'no_interaction');
    if (angDiff(moves[moves.length - 1][1], angle) > 1) return failResponse(req, res, 'inconsistent');

    if (angDiff(angle, c.answer) > cfg.toleranceDeg) return failResponse(req, res, 'wrong_angle');

    fails.delete(clientIp(req)); // success resets the consecutive-fail counter
    const token = sign({ v: 1, jti: crypto.randomBytes(8).toString('hex'), iat: now, exp: now + cfg.tokenTtlMs });
    res.json({ ok: true, token, expiresInMs: cfg.tokenTtlMs });
  });

  // --- GET /gate : exchange a valid token for the gate's destination link, so the link is
  //     never present in the static page until verification has succeeded ---
  app.get('/gate', limit('gate'), (req, res) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const p = m && unsign(m[1]);
    if (!p) return res.status(401).json({ error: 'invalid_token' });
    res.json({ yesUrl: cfg.yesUrl });
  });

  return app;
}

module.exports = { createApp, angDiff };
