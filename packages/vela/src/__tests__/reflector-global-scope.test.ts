import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { build } from 'tsdown';
import { expect, it } from 'vitest';

// The Workers vitest pool imports modules inside a request, so it cannot
// observe workerd's global-scope restrictions. Boot a bundled Worker whose
// main module creates decorators at module scope instead.
it('creates typed decorators in workerd global scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vela-global-scope-'));
  let runtime: Miniflare | undefined;
  try {
    await build({
      config: false,
      entry: [
        fileURLToPath(new URL('./fixtures/module-scope-decorator.worker.ts', import.meta.url)),
      ],
      outDir: directory,
      format: ['esm'],
      dts: false,
      sourcemap: false,
      platform: 'neutral',
      target: 'es2024',
      deps: { alwaysBundle: [/.*/] },
      logLevel: 'silent',
    });
    const modules = Object.fromEntries(
      await Promise.all(
        (await readdir(directory))
          .filter((file) => file.endsWith('.js'))
          .map(async (file) => [
            file,
            { type: 'esm' as const, contents: await readFile(join(directory, file), 'utf8') },
          ]),
      ),
    );
    runtime = new Miniflare({
      workers: [
        {
          config: {
            name: 'module-scope-decorator',
            type: 'worker',
            compatibilityDate: '2026-05-01',
            manifest: { mainModule: 'module-scope-decorator.worker.js', modules },
          },
        },
      ],
    });

    const response = await runtime.dispatchFetch('https://worker.test/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ distinct: true, audience: 'internal' });
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
