import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const common = { modules: true, compatibilityDate: '2026-09-22' };
// `vite build` writes each Worker to dist/<environment>/, named after its
// Wrangler `name` ("module-api" -> "module_api").
const bundle = (name) => resolve(`dist/module_${name}/index.js`);
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        ...common,
        name: 'api',
        scriptPath: bundle('api'),
        serviceBindings: {
          CATALOG: 'catalog',
          ACCOUNTS: 'accounts',
          NATIVE_CATALOG: {
            name: 'catalog',
            entrypoint: 'Catalog',
            props: { caller: 'example-api' },
          },
          UNTRUSTED_CATALOG: {
            name: 'catalog',
            entrypoint: 'Catalog',
            props: { caller: 'untrusted', subject: 'alice' },
          },
        },
        queueProducers: { TASKS: 'module-tasks' },
      },
      {
        ...common,
        name: 'catalog',
        scriptPath: bundle('catalog'),
        serviceBindings: {
          IDENTITY: { name: 'accounts', entrypoint: 'Identity' },
          MEMBERSHIP: { name: 'accounts', entrypoint: 'Membership' },
        },
      },
      { ...common, name: 'accounts', scriptPath: bundle('accounts') },
      {
        ...common,
        name: 'jobs',
        scriptPath: bundle('jobs'),
        kvNamespaces: ['RESULTS'],
        queueConsumers: { 'module-tasks': { maxBatchSize: 1, maxBatchTimeout: 0 } },
      },
    ],
  }),
);
try {
  const api = await runtime.getWorker('api');
  assert.deepEqual(await (await api.fetch('https://api/api/document')).json(), {
    document: { id: 'document-1', label: 'Example document' },
    owner: { id: 'account-1', active: true },
  });
  const call = (body, path = 'native') =>
    api.fetch(`https://api/api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const inputs = [
    { credential: 'fixture-alice', tenantId: 'team-a', documentId: 'document-a' },
    { credential: 'fixture-bob', tenantId: 'team-b', documentId: 'document-b' },
  ];
  const resultsNative = await Promise.all(
    inputs.map(async (input) => {
      const response = await call(input);
      assert.equal(response.status, 201);
      return response.json();
    }),
  );
  assert.deepEqual(resultsNative, [
    { subject: 'alice', tenantId: 'team-a', documentId: 'document-a', frozen: true },
    { subject: 'bob', tenantId: 'team-b', documentId: 'document-b', frozen: true },
  ]);
  for (const input of [
    { ...inputs[0], credential: undefined },
    { ...inputs[0], credential: 'forged' },
    { ...inputs[0], tenantId: 'team-b' },
    { ...inputs[0], credential: 'fixture-no-permission' },
    { ...inputs[0], credential: 'fixture-no-resource' },
    { ...inputs[0], documentId: 'document-b' },
    { ...inputs[0], documentId: 'missing-document' },
  ]) {
    const response = await call(input);
    assert.equal(response.status, 403, `Native authorization denied ${JSON.stringify(input)}`);
  }
  assert.equal((await call(inputs[0], 'untrusted')).status, 403);
  // A denied invocation cannot contaminate a later authenticated call.
  assert.equal((await call(inputs[0])).status, 201);
  assert.equal((await api.fetch('https://api/api/tasks', { method: 'POST' })).status, 201);
  const results = await runtime.getKVNamespace('RESULTS', 'jobs');
  const deadline = Date.now() + 10000;
  while (!(await results.get('last-job')) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(JSON.parse(await results.get('last-job')), { source: 'api', attempt: 1 });
  await (await runtime.getWorker('jobs')).scheduled({ cron: '* * * * *' });
  assert.equal(await results.get('last-cron'), 'completed');
  // The jobs bundle's source map lists every module Vite bundled into it.
  const { sources } = JSON.parse(await readFile(`${bundle('jobs')}.map`, 'utf8'));
  assert(
    sources.some((path) => path.endsWith('src/jobs.ts')),
    'the jobs source map lists src/jobs.ts',
  );
  assert(!sources.some((path) => /src\/(api|catalog|accounts)\.ts$/.test(path)));
  console.log(
    'Four native Workers passed: HTTP RPC, verified native identity/tenant/permissions/Cedar, queue, cron, and separate bundles.',
  );
} finally {
  await runtime.dispose();
}
