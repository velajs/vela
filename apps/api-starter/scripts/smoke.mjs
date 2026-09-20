import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createLiveClient } from '@velajs/client';
import { createPresence } from '@velajs/client/presence';
import { queries, todoSchema } from '../dist/contracts.js';

const origin = process.env.APP_ORIGIN ?? 'http://localhost:8790';
let token = process.env.VELA_STUDIO_TOKEN;
if (!token && new URL(origin).hostname === 'localhost') {
  const vars = await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
  token = vars.match(/^VELA_STUDIO_TOKEN="?([^"\n]+)"?$/m)?.[1];
}
assert.ok(token, 'Provide VELA_STUDIO_TOKEN for the target Worker');
let cookie = '';
async function request(path, method = 'GET', json, admin = false) {
  return fetch(`${origin}${path}`, { method, headers: {
    origin, ...(cookie ? { cookie } : {}), ...(json ? { 'content-type': 'application/json' } : {}),
    ...(admin ? { authorization: `Bearer ${token}` } : {}),
  }, ...(json ? { body: JSON.stringify(json) } : {}) });
}
async function json(response, status = 200) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}
async function rpc(op) {
  const body = await json(await request(`/_vela/admin/rpc/${op}`, 'POST', { args: {} }, true));
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.data;
}
async function eventually(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

assert.equal((await request('/')).status, 200);
await json(await request('/healthz'));
assert.equal((await request('/todos')).status, 401);
assert.equal((await request('/_vela/admin/rpc/live.subscriptions', 'POST', { args: {} })).status, 401);
const password = randomUUID();
const email = `vela-smoke-${randomUUID()}@example.com`;
const signup = await request('/api/auth/sign-up/email', 'POST', { name: 'Release smoke', email, password });
await json(signup);
cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie, 'Sign-up must return a session cookie');
assert.equal((await json(await request('/me'))).email, email);

let rows = [];
const live = createLiveClient({ url: origin, queries, heartbeatIntervalMs: 0,
  WebSocket: url => new WebSocket(url, { headers: { cookie, origin } }),
});
let presence;
let todo;
try {
  live.subscribe('todos.list', {}, value => { rows = value ?? []; });
  presence = createPresence(live, { room: 'default', meta: { source: 'smoke' } });
  const caps = await rpc('studio.capabilities');
  assert.ok(caps.operations.includes('live.subscriptions'));
  assert.ok(caps.operations.includes('presence.rooms'));
  await eventually(async () => (await rpc('live.subscriptions')).some(row => row.room === 'default'), 'Studio subscription inspection');
  await eventually(async () => (await rpc('presence.rooms')).some(row => row.room === 'default' && row.count > 0), 'Studio presence inspection');
  const created = await json(await request('/todos', 'POST', { title: 'Release smoke', done: false }), 201);
  todo = todoSchema.parse(created.result);
  await eventually(() => rows.some(row => row.id === todo.id), 'live create');
  const patched = await json(await request(`/todos/${todo.id}`, 'PATCH', { done: true }));
  assert.equal(todoSchema.parse(patched.result).done, true);
  await eventually(() => rows.some(row => row.id === todo.id && row.done), 'live update');
  const listed = await json(await request('/todos'));
  assert.ok(listed.result.some(row => row.id === todo.id));
  await json(await request(`/todos/${todo.id}`, 'DELETE'));
  await eventually(() => !rows.some(row => row.id === todo.id), 'live delete');
  todo = undefined;
  const models = await rpc('data.listModels');
  assert.ok(models.some(model => model.name === 'todo'), JSON.stringify(models));
  console.log(`PASS ${origin}: auth, D1 CRUD, live create/update/delete, Studio models/subscriptions/presence`);
} finally {
  presence?.stop();
  live.close();
  if (todo) await request(`/todos/${todo.id}`, 'DELETE');
  await json(await request('/api/auth/delete-user', 'POST', { password }));
}
