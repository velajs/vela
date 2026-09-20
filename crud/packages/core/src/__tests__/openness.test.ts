import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Import-audit (queue-openness pattern): the package must be authored 100% on
 * Vela's PUBLIC API and stay edge-safe. Machine-verified so it cannot rot:
 *
 * 1. no `@velajs/vela/internal` anywhere (the old bridge's ComponentManager
 *    reach died with the RouteContributor);
 * 2. no `hono-crud` imports (the dependency this rewrite retired);
 * 3. no `node:*` / bare node builtins in product code (tests excluded).
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function importsOf(file: string): string[] {
  const content = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const pattern =
    /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of content.matchAll(pattern)) {
    specifiers.push((match[1] ?? match[2])!);
  }
  return specifiers;
}

const NODE_BUILTINS = new Set([
  'fs',
  'path',
  'os',
  'crypto',
  'http',
  'https',
  'net',
  'tls',
  'stream',
  'util',
  'events',
  'buffer',
  'child_process',
  'worker_threads',
  'async_hooks',
  'url',
  'zlib',
]);

describe('openness + edge audit', () => {
  const files = sourceFiles(SRC);

  it('finds a plausible amount of source', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('never imports @velajs/vela/internal', () => {
    const offenders = files.filter((f) =>
      importsOf(f).some((s) => s.startsWith('@velajs/vela/internal')),
    );
    expect(offenders).toEqual([]);
  });

  it('never imports hono-crud', () => {
    const offenders = files.filter((f) =>
      importsOf(f).some(
        (s) => s === 'hono-crud' || s.startsWith('hono-crud/') || s.startsWith('@hono-crud/'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('never imports node builtins in product code', () => {
    const offenders = files.filter((f) =>
      importsOf(f).some((s) => s.startsWith('node:') || NODE_BUILTINS.has(s)),
    );
    expect(offenders).toEqual([]);
  });

  it('never references Buffer or process globals in product code', () => {
    const offenders = files.filter((f) => {
      const content = readFileSync(f, 'utf8');
      return /\bBuffer\.|(?<![.\w])process\.(?:env|exit|on)\b/.test(content);
    });
    expect(offenders).toEqual([]);
  });
});
