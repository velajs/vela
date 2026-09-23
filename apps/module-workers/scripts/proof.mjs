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
        serviceBindings: { CATALOG: 'catalog', ACCOUNTS: 'accounts' },
        queueProducers: { TASKS: 'module-tasks' },
      },
      { ...common, name: 'catalog', scriptPath: bundle('catalog') },
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
  assert.equal((await api.fetch('https://api/api/tasks', { method: 'POST' })).status, 200);
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
    'Four native Workers passed: composed RPC API, queue delivery, cron, and separate bundles.',
  );
} finally {
  await runtime.dispose();
}
