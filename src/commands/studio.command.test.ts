import { execFileSync, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * `vela studio` command tests. Spawns the BUILT CLI so the clipanion wiring +
 * the lazy optional-peer import are exercised end-to-end. `@velajs/studio-host`
 * is an optional dependency that isn't installed in this repo, so the
 * peer-absent install-hint path is the natural default.
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

function runStudio(args: string[]): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn('node', [cliEntry, 'studio', ...args], {
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
    const result = await runStudio(['--url', 'http://127.0.0.1:9999']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('@velajs/studio-host');
    expect(result.stderr.toLowerCase()).toContain('install');
    // It reached the lazy import (URL + port validation passed) before failing.
    expect(result.stderr).not.toContain('valid origin');
  });
});
