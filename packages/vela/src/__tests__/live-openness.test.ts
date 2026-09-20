import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runProtocolConformance } from '@velajs/live-protocol';

/**
 * The live module follows the QueueModule "openness proof" discipline: a whole
 * feature module authored on the PUBLIC API alone, plus two public packages an
 * external author could equally import — `@velajs/live-protocol` (the shared
 * wire contract) and `hono/context-storage` (ambient commit-header stamping).
 * This audit machine-verifies it, and runs the shared protocol conformance
 * suite so the server-side codec can never drift from the golden fixtures.
 */
const LIVE_DIR = join(__dirname, '..', 'live');
const INDEX_SOURCE = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');

const ALLOWED_EXTERNAL = new Set(['../index', '@velajs/live-protocol', 'hono/context-storage']);

interface ParsedImport {
  file: string;
  specifier: string;
  symbols: string[];
}

function parseImports(file: string, source: string): ParsedImport[] {
  const out: ParsedImport[] = [];
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importRe)) {
    const symbols = match[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) =>
        s
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          .trim(),
      );
    out.push({ file, specifier: match[2], symbols });
  }
  return out;
}

function publicExportNames(): Set<string> {
  const names = new Set<string>();
  for (const match of INDEX_SOURCE.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().replace(/^type\s+/, '');
      if (!name) continue;
      const parts = name.split(/\s+as\s+/);
      names.add(parts[parts.length - 1].trim());
    }
  }
  for (const match of INDEX_SOURCE.matchAll(
    /export\s+(?:const|class|function|interface|enum)\s+(\w+)/g,
  )) {
    names.add(match[1]);
  }
  return names;
}

describe('LiveModule openness proof', () => {
  const files = readdirSync(LIVE_DIR).filter((f) => f.endsWith('.ts'));
  const imports = files.flatMap((f) => parseImports(f, readFileSync(join(LIVE_DIR, f), 'utf8')));

  it('imports vela only through the public barrel (plus the two public packages)', () => {
    const offenders = imports.filter(
      (imp) => !imp.specifier.startsWith('./') && !ALLOWED_EXTERNAL.has(imp.specifier),
    );
    expect(offenders.map((o) => `${o.file}: '${o.specifier}'`)).toEqual([]);
  });

  it('uses only symbols the public barrel exports', () => {
    const publicNames = publicExportNames();
    const missing = imports
      .filter((imp) => imp.specifier === '../index')
      .flatMap((imp) =>
        imp.symbols.filter((s) => !publicNames.has(s)).map((s) => `${imp.file}: ${s}`),
      );
    expect(missing).toEqual([]);
  });

  it('covers the whole module (sanity: files and imports were found)', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(imports.some((imp) => imp.specifier === '../index')).toBe(true);
  });

  it('conforms to the shared wire protocol (golden fixtures + randomized sweep)', () => {
    const report = runProtocolConformance();
    expect(report.failures).toEqual([]);
  });
});
