'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');

async function boot(opts = {}) {
  const app = createApp({ secret: crypto.randomBytes(32).toString('hex'), minSolveMs: 50, ...opts });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const close = () => { app.locals.stop(); srv.close(); };
  return { app, base, close };
}
const moves = (a) => [[0, 0], [100, a * 0.3], [250, a * 0.6], [400, a * 0.9], [520, a]];
const post = (base, body) => fetch(`${base}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('challenge never leaks the answer', async () => {
  const { app, base, close } = await boot();
  const ch = await (await fetch(`${base}/challenge`)).json();
  const stored = app.locals.challenges.get(ch.id);
  const text = JSON.stringify({ ...ch, outer: '', inner: '' });
  assert.ok(!text.includes(String(stored.answer)) && !text.includes(String(stored.offset)));
  assert.deepStrictEqual(Object.keys(ch).sort(), ['expiresInMs', 'id', 'inner', 'innerSize', 'outer', 'size']);
  assert.match(ch.outer, /^data:image\/webp;base64,/);
  close();
});

test('wrong angle fails, correct passes, replay fails', async () => {
  const { app, base, close } = await boot();
  // wrong
  let ch = await (await fetch(`${base}/challenge`)).json();
  let ans = app.locals.challenges.get(ch.id).answer;
  await wait(80);
  let r = await post(base, { id: ch.id, angle: (ans + 90) % 360, moves: moves((ans + 90) % 360) });
  assert.strictEqual(r.json.ok, false); assert.strictEqual(r.json.error, 'wrong_angle');
  // even the right angle afterwards fails: one attempt per challenge
  r = await post(base, { id: ch.id, angle: ans, moves: moves(ans) });
  assert.strictEqual(r.json.ok, false);
  // correct (within tolerance, wrapping handled)
  ch = await (await fetch(`${base}/challenge`)).json();
  ans = app.locals.challenges.get(ch.id).answer;
  await wait(80);
  const near = (ans + 7 + 360) % 360;
  r = await post(base, { id: ch.id, angle: near, moves: moves(near) });
  assert.strictEqual(r.json.ok, true); assert.ok(r.json.token);
  // replay
  r = await post(base, { id: ch.id, angle: near, moves: moves(near) });
  assert.strictEqual(r.json.ok, false); assert.strictEqual(r.json.error, 'unknown_or_used');
  // token opens gate; garbage does not
  let g = await fetch(`${base}/gate`, { headers: { authorization: `Bearer ${(await (async () => { const c2 = await (await fetch(`${base}/challenge`)).json(); const a2 = app.locals.challenges.get(c2.id).answer; await wait(80); return (await post(base, { id: c2.id, angle: a2, moves: moves(a2) })).json.token; })())}` } });
  assert.strictEqual(g.status, 200); assert.match((await g.json()).yesUrl, /^https:\/\/onlyfans\.com\//);
  g = await fetch(`${base}/gate`, { headers: { authorization: 'Bearer abc.def' } });
  assert.strictEqual(g.status, 401);
  close();
});

test('9+ degrees off fails (tolerance boundary)', async () => {
  const { app, base, close } = await boot();
  const ch = await (await fetch(`${base}/challenge`)).json();
  const ans = app.locals.challenges.get(ch.id).answer;
  await wait(80);
  const a = (ans + 9) % 360;
  const r = await post(base, { id: ch.id, angle: a, moves: moves(a) });
  assert.strictEqual(r.json.error, 'wrong_angle');
  close();
});

test('behaviour checks: too fast, no moves', async () => {
  const { app, base, close } = await boot({ minSolveMs: 400 });
  let ch = await (await fetch(`${base}/challenge`)).json();
  let ans = app.locals.challenges.get(ch.id).answer;
  let r = await post(base, { id: ch.id, angle: ans, moves: moves(ans) });
  assert.strictEqual(r.json.error, 'too_fast');
  ch = await (await fetch(`${base}/challenge`)).json();
  ans = app.locals.challenges.get(ch.id).answer;
  await wait(450);
  r = await post(base, { id: ch.id, angle: ans, moves: [[0, ans]] });
  assert.strictEqual(r.json.error, 'no_interaction');
  close();
});

test('challenge expires', async () => {
  const { app, base, close } = await boot({ challengeTtlMs: 100 });
  const ch = await (await fetch(`${base}/challenge`)).json();
  const ans = app.locals.challenges.get(ch.id).answer;
  await wait(150);
  const r = await post(base, { id: ch.id, angle: ans, moves: moves(ans) });
  assert.strictEqual(r.json.ok, false);
  close();
});

test('rate limit per IP', async () => {
  const { base, close } = await boot({ rateLimit: { windowMs: 60000, challenge: 3, verify: 3, gate: 3 } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/challenge`)).status);
  assert.deepStrictEqual(codes, [200, 200, 200, 429, 429]);
  close();
});

test('expired/forged tokens rejected', async () => {
  const { app, base, close } = await boot({ tokenTtlMs: 50 });
  const ch = await (await fetch(`${base}/challenge`)).json();
  const ans = app.locals.challenges.get(ch.id).answer;
  await wait(80);
  const { json } = await post(base, { id: ch.id, angle: ans, moves: moves(ans) });
  await wait(80);
  assert.strictEqual((await fetch(`${base}/gate`, { headers: { authorization: `Bearer ${json.token}` } })).status, 401);
  const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 1e6 })).toString('base64url') + '.AAAA';
  assert.strictEqual((await fetch(`${base}/gate`, { headers: { authorization: `Bearer ${forged}` } })).status, 401);
  close();
});
