import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('accepts native Workers Fetcher bindings in a Workers-global consumer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vela-http-workers-types-'));
  try {
    const entry = fileURLToPath(new URL('../../dist/fetch/index.js', import.meta.url));
    const workers = fileURLToPath(
      new URL('../../../../node_modules/@cloudflare/workers-types/index.d.ts', import.meta.url),
    );
    writeFileSync(
      join(directory, 'consumer.ts'),
      `
      import { HttpService, type HttpModuleOptions } from ${JSON.stringify(entry)};
      declare const binding: Fetcher;
      const options: HttpModuleOptions = { transport: binding, headers: new Headers() };
      const http = new HttpService(options);
      const result = await http.get('https://internal.example/items', {
        transport: binding,
        signal: new AbortController().signal,
        schema: { '~standard': { version: 1, vendor: 'test', types: undefined as { input: unknown; output: { count: number } } | undefined, validate: () => ({ value: { count: 1 } }) } },
      });
      const count: number = result.data.count;
      // @ts-expect-error The schema produces numbers.
      const invalid: string = result.data.count;
      void [count, invalid];
    `,
    );
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2024',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2024'],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        files: ['consumer.ts', workers],
      }),
    );
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsc', '--project', join(directory, 'tsconfig.json')],
      {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
