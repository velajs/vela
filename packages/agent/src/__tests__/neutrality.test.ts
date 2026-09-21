import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));

/** Collect every shipped `.ts` file under src, excluding the test tree. */
const shippedSources = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...shippedSources(join(dir, entry.name)));
    } else if (entry.name.endsWith('.ts')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
};

/** Extract the module specifiers of every static/dynamic import from a source string. */
const importSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  const patterns = [
    /(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
};

describe('edge-neutrality gate', () => {
  const files = shippedSources(SRC_DIR);

  it('finds shipped source to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('imports no cloudflare:*, node:*, or @velajs/vela specifier', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (
          spec.startsWith('cloudflare:') ||
          spec.startsWith('node:') ||
          spec === '@velajs/vela' ||
          spec.startsWith('@velajs/vela/')
        ) {
          offenders.push(`${file} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('references no process / Buffer global in shipped source', () => {
    const offenders: string[] = [];
    for (const file of files) {
      // Strip comments first — the neutrality rule is about runtime code, and doc
      // comments legitimately mention `process` / `Buffer` while describing it.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (/\bprocess\s*\./.test(code) || /\bBuffer\b/.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports @velajs/mail only as a type (never at runtime)', () => {
    const offenders: string[] = [];
    const importsMail = /(?:\bfrom\s*['"]@velajs\/mail['"]|\bimport\s*\(\s*['"]@velajs\/mail)/;
    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (importsMail.test(line) && !/\b(?:import|export)\s+type\b/.test(line)) {
          offenders.push(`${file} -> ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares the right dependency shape in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      devDependencies?: Record<string, string>;
    };

    // No framework dependency, and mail remains an optional, type-only integration.
    expect(pkg.dependencies ?? {}).not.toHaveProperty('@velajs/vela');
    expect(pkg.dependencies ?? {}).not.toHaveProperty('@velajs/mail');
    expect(pkg.peerDependencies?.['@velajs/mail']).toMatch(/^workspace:\^/);
    expect(pkg.peerDependenciesMeta?.['@velajs/mail']?.optional).toBe(true);

    // Runtime deps: the durable-workflow core and the stable error layer.
    expect(pkg.dependencies ?? {}).toHaveProperty('@velajs/workflow');
    expect(pkg.dependencies ?? {}).toHaveProperty('@velajs/errors');
  });
});
