import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';

it('uses installed Wrangler for native handle types, default environment unions and a selected environment', async () => {
  const project = await mkdtemp(join(tmpdir(), 'vela-binding-types-'));
  const require = createRequire(import.meta.url);
  const wrangler = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
  try {
    await writeFile(
      join(project, 'worker.ts'),
      'export default { fetch() { return new Response("ok"); } };',
    );
    await writeFile(
      join(project, 'wrangler.json'),
      JSON.stringify({
        name: 'example',
        main: 'worker.ts',
        compatibility_date: '2026-09-20',
        assets: { binding: 'ASSETS', directory: './public' },
        flagship: [{ binding: 'FLAGS', app_id: 'example-app' }],
        secrets_store_secrets: [
          {
            binding: 'API_KEY',
            store_id: '00000000000000000000000000000000',
            secret_name: 'example-key',
          },
        ],
        env: {
          staging: { ai: { binding: 'AI' }, assets: { binding: 'ASSETS', directory: './public' } },
        },
      }),
    );
    const generate = (environment: string) => {
      const result = spawnSync(
        process.execPath,
        [wrangler, 'types', '--include-runtime=false', '--env', environment],
        {
          cwd: project,
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
        },
      );
      expect(result.status, result.stderr).toBe(0);
    };
    generate('');
    const top = await readFile(join(project, 'worker-configuration.d.ts'), 'utf8');
    expect(top).toContain('FLAGS?: Flagship;');
    expect(top).toContain('API_KEY?: SecretsStoreSecret;');
    expect(top).toContain('ASSETS: Fetcher;');
    expect(top).toContain('AI?: Ai;');
    generate('staging');
    const staging = await readFile(join(project, 'worker-configuration.d.ts'), 'utf8');
    expect(staging).toContain('AI: Ai;');
    expect(staging).toContain('ASSETS: Fetcher;');
    expect(staging).not.toContain('FLAGS:');
    expect(staging).not.toContain('API_KEY:');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
