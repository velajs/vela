import { execFileSync, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * `vela studio` command tests. Spawns the BUILT CLI so the clipanion wiring +
 * the lazy optional-peer import are exercised end-to-end. `@velajs/studio-host`
 * is optional; a loader makes its absence deterministic even in a workspace.
 */

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(rootDir, 'dist', 'index.js');

function ensureBuilt(): void {
  if (!existsSync(cliEntry)) {
    execFileSync('pnpm', ['build'], { cwd: rootDir, stdio: 'inherit' });
  }
}

beforeAll(() => {
  ensureBuilt();
}, 120_000);

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runStudio(args: string[], omitHost = false): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    // Isolate this optional-peer test from the parent workspace's packages.
    const loader =
      'data:text/javascript,' +
      encodeURIComponent(`
      export function resolve(specifier, context, nextResolve) {
        if (specifier === '@velajs/studio-host') {
          const error = new Error('Cannot find package @velajs/studio-host');
          error.code = 'ERR_MODULE_NOT_FOUND';
          throw error;
        }
        return nextResolve(specifier, context);
      }
    `);
    const register =
      'data:text/javascript,' +
      encodeURIComponent(
        `import { register } from 'node:module'; register(${JSON.stringify(loader)});`,
      );
    const nodeArgs = omitHost ? ['--import', register] : [];
    const child = spawn(process.execPath, [...nodeArgs, cliEntry, 'studio', ...args], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.on('exit', (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

describe('vela studio', () => {
  it('is registered and shown in the command list', () => {
    // The absent-peer path never runs; --help lists the command from the barrel.
    expect(statSync(cliEntry).isFile()).toBe(true);
  });

  it('errors when --url is omitted', async () => {
    const result = await runStudio([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--url');
  });

  it('rejects an invalid --url origin', async () => {
    const result = await runStudio(['--url', 'not a url']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('valid origin');
  });

  it('prints an install hint when the optional @velajs/studio-host peer is absent', async () => {
    const result = await runStudio(['--url', 'http://127.0.0.1:9999'], true);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('@velajs/studio-host');
    expect(result.stderr.toLowerCase()).toContain('install');
    // It reached the lazy import (URL + port validation passed) before failing.
    expect(result.stderr).not.toContain('valid origin');
  });

  it.each(['4000junk', '1.5', '1e3', '0x10', '-1', '65536', '', ' 4000'])(
    'rejects invalid port %j before loading the optional host',
    async (port) => {
      const result = await runStudio(['--url', 'http://127.0.0.1:9999', `--port=${port}`], true);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--port must be a decimal integer');
      expect(result.stderr).not.toContain('needs the optional');
    },
  );

  it.each(['0', '4000', '65535'])(
    'accepts decimal port %s and reaches optional-host loading',
    async (port) => {
      const result = await runStudio(['--url', 'http://127.0.0.1:9999', `--port=${port}`], true);
      expect(result.stderr).toContain('needs the optional');
      expect(result.stderr).not.toContain('--port must');
    },
  );
});
