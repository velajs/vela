import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

// Every Wrangler app in apps/ builds, serves and tests its Worker straight from
// TypeScript with Vite 8 and Oxc, like the `vela new` starter. None of them
// precompiles with SWC, so the Wrangler entry, the generated binding types and
// the DI metadata never depend on a stale build.
const root = new URL('../../', import.meta.url);
const tracked = execFileSync('git', ['ls-files', 'apps'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const apps = [...new Set(tracked.map((file) => file.split('/').slice(0, 2).join('/')))];
const read = (path) => readFile(new URL(path, root), 'utf8');
const manifest = async (app) => JSON.parse(await read(`${app}/package.json`));
const wranglerFiles = tracked.filter((file) =>
  /^wrangler(\.[\w-]+)?\.(jsonc?|toml)$/.test(basename(file)),
);
const wranglerApps = [...new Set(wranglerFiles.map((file) => dirname(file)))];

/** The `main` entry of a Wrangler file, from its JSON(C) key or TOML assignment. */
function wranglerMain(source) {
  return (source.match(/^\s*"main"\s*:\s*"([^"]+)"/m) ??
    source.match(/^main\s*=\s*"([^"]+)"/m))?.[1];
}

test('the Wrangler apps are discovered', () => {
  for (const app of ['apps/api-starter', 'apps/module-workers', 'apps/graphql-worker'])
    assert.ok(wranglerApps.includes(app), `${app} has a Wrangler file`);
});

test('no app compiles with SWC', async () => {
  assert.deepEqual(
    tracked.filter((file) => basename(file) === '.swcrc'),
    [],
  );
  for (const app of apps) {
    const pkg = await manifest(app);
    for (const [name, script] of Object.entries(pkg.scripts ?? {}))
      assert.doesNotMatch(script, /(^|[\s&;|])swc\s/, `${app} script ${name} runs the SWC CLI`);
    assert.equal(pkg.devDependencies?.['@swc/cli'], undefined, `${app} depends on @swc/cli`);
  }
  for (const app of wranglerApps) {
    const pkg = await manifest(app);
    for (const name of ['@swc/core', 'unplugin-swc'])
      assert.equal(pkg.devDependencies?.[name], undefined, `${app} depends on ${name}`);
  }
});

test('every Wrangler entry is a TypeScript source file', async () => {
  for (const file of wranglerFiles) {
    const main = wranglerMain(await read(file));
    assert.match(main ?? '', /^src\/[\w./-]+\.ts$/, `${file} main is ${main}`);
  }
});

test('every Wrangler app builds with Vite and Oxc decorator metadata', async () => {
  for (const app of wranglerApps) {
    const pkg = await manifest(app);
    for (const name of ['vite', '@cloudflare/vite-plugin'])
      assert.equal(pkg.devDependencies?.[name], 'catalog:', `${app} installs ${name}`);
    assert.match(pkg.scripts?.build ?? '', /\bvite build\b/, `${app} builds with Vite`);
    assert.match(pkg.scripts?.dev ?? '', /\bvite dev\b/, `${app} serves with Vite`);
    const config = await read(`${app}/vite.config.ts`);
    assert.match(config, /cloudflare\(/, `${app} uses the Cloudflare Vite plugin`);
    // The decorator options live in the config or in the oxc.config.ts it imports.
    const options = existsSync(new URL(`${app}/oxc.config.ts`, root))
      ? config + (await read(`${app}/oxc.config.ts`))
      : config;
    assert.match(options, /legacy: true/, `${app} compiles legacy decorators`);
    assert.match(options, /emitDecoratorMetadata: true/, `${app} emits design:paramtypes`);
  }
});

test('every Wrangler file commits binding types generated from the source entry', async () => {
  for (const wrangler of wranglerFiles) {
    // wrangler.jsonc -> worker-configuration.d.ts; wrangler.api.jsonc -> worker-configuration.api.d.ts
    const worker = basename(wrangler).match(/^wrangler((?:\.[\w-]+)?)\.(?:jsonc?|toml)$/)[1];
    const file = `${dirname(wrangler)}/worker-configuration${worker}.d.ts`;
    assert.ok(tracked.includes(file), `${wrangler} has committed binding types in ${file}`);
    const source = await read(file);
    // Wrangler writes a bare `DurableObjectNamespace /* Class */` when it cannot
    // read the class from `main`, and names the entry as mainModule when it can.
    assert.doesNotMatch(source, /DurableObjectNamespace \/\*/, `${file} types its Durable Objects`);
    assert.match(source, /mainModule: typeof import\("\.\/src\//, `${file} reads the source entry`);
  }
});
