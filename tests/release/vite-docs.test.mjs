import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Vite builds the Worker with decorator metadata; `wrangler deploy --config`
// would bundle the source with esbuild instead, and the CLI loads
// vela.config.ts and its decorated sources through Vite without a build.
const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the deployment check example builds with Vite before its Wrangler dry-run', async () => {
  const workflow = await read('docs/examples/deployment-check.yml');
  const steps = workflow.match(/^\s*- run: .*$/gm).map((line) => line.replace(/^\s*- run: /, ''));
  const build = steps.indexOf('CLOUDFLARE_ENV=staging pnpm build');
  const dryRun = steps.indexOf('pnpm exec wrangler deploy --dry-run');
  assert.ok(build >= 0, 'the example builds the staging Worker with Vite');
  assert.ok(dryRun > build, 'the dry-run follows the build');
  assert.deepEqual(
    steps.filter((step) => /wrangler deploy.*--(config|env)\b/.test(step)),
    [],
    'wrangler deploy follows the Vite build redirect',
  );
});

test('the seeding guide loads vela.config.ts and the decorated source without a build', async () => {
  const guide = await read('docs/seeding.md');
  assert.match(guide, /`vela\.config\.ts`/);
  assert.match(guide, /\.\/src\/app\.module/);
  assert.doesNotMatch(guide, /^pnpm build$/m);
});
