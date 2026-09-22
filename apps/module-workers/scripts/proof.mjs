import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const common = { modules: true, compatibilityDate: '2026-09-22' };
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        ...common,
        name: 'api',
        scriptPath: resolve('dist/api.mjs'),
        serviceBindings: { CATALOG: 'catalog', ACCOUNTS: 'accounts' },
        queueProducers: { TASKS: 'module-tasks' },
      },
      { ...common, name: 'catalog', scriptPath: resolve('dist/catalog.mjs') },
      { ...common, name: 'accounts', scriptPath: resolve('dist/accounts.mjs') },
      {
        ...common,
        name: 'jobs',
        scriptPath: resolve('dist/jobs.mjs'),
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
  const meta = JSON.parse(await readFile('dist/jobs.meta.json', 'utf8'));
  assert(!Object.keys(meta.inputs).some((path) => /src\/(api|catalog|accounts)\.ts$/.test(path)));
  console.log(
    'Four native Workers passed: composed RPC API, queue delivery, cron, and separate bundles.',
  );
} finally {
  await runtime.dispose();
}
