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

/** Extract the module specifiers of every static/dynamic import (not comment text). */
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

describe('clean-neutrality gate', () => {
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

  it('declares no @velajs/vela dependency in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.dependencies ?? {}).not.toHaveProperty('@velajs/vela');
    expect(pkg.peerDependencies ?? {}).not.toHaveProperty('@velajs/vela');
    expect(pkg.devDependencies ?? {}).not.toHaveProperty('@velajs/vela');

    // The one published runtime dependency is the stable error layer.
    expect(pkg.dependencies ?? {}).toHaveProperty('@velajs/errors');
  });
});
