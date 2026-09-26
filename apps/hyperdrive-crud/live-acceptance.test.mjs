import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAcceptance } from './live-acceptance.mjs';
const options = {
  url: 'https://synthetic.example',
  token: 'synthetic',
  confirm: 'pre-existing-synthetic-cache-disabled',
};
test('requires explicit synthetic authorization before making requests', async () => {
  let calls = 0;
  await assert.rejects(
    runAcceptance({}, () => {
      calls++;
    }),
    /Confirm/,
  );
  await assert.rejects(
    runAcceptance({ ...options, url: 'http://synthetic.example' }, () => {
      calls++;
    }),
    /HTTPS/,
  );
  assert.equal(calls, 0);
});
test('waits for all in-flight creates before cleaning up after one failure', async () => {
  const rows = new Set();
  let creates = 0,
    deletes = 0;
  await assert.rejects(
    runAcceptance(options, async (url, request) => {
      assert.equal(request.redirect, 'error');
      if (request.method === 'POST') {
        const n = ++creates;
        if (n === 1) throw new Error('network failure');
        await new Promise((resolve) => setTimeout(resolve, n * 5));
        rows.add(JSON.parse(request.body).id);
        return Response.json({}, { status: 201 });
      }
      if (request.method === 'DELETE') {
        deletes++;
        rows.delete(url.pathname.split('/').at(-1));
        return Response.json({});
      }
      throw new Error('unexpected request');
    }),
    /acceptance failed/,
  );
  assert.equal(deletes, 3);
  assert.equal(rows.size, 0);
});
