import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The QueueModule is the roadmap's "openness proof": a whole feature module
 * authored on the PUBLIC API alone. This audit machine-verifies the claim:
 *
 * 1. every vela import in src/queue/* comes from the public barrel
 *    ('../index') or from inside the queue module itself — never a deep
 *    private path; and
 * 2. every symbol imported from '../index' is actually exported there
 *    (so an external author could write the same module against
 *    '@velajs/vela' verbatim).
 */
const QUEUE_DIR = join(__dirname, '..', 'queue');
const INDEX_SOURCE = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');

interface ParsedImport {
  file: string;
  specifier: string;
  symbols: string[];
}

function parseImports(file: string, source: string): ParsedImport[] {
  const out: ParsedImport[] = [];
  // Covers `import { a, b } from 'x'`, `import type { a } from 'x'`, and
  // mixed default/named forms; the queue module uses named imports only.
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importRe)) {
    const symbols = match[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      // `type X` inside a value import clause, and `X as Y` aliasing:
      // the PUBLIC name is the left-hand side.
      .map((s) => s.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim());
    out.push({ file, specifier: match[2], symbols });
  }
  return out;
}

function publicExportNames(): Set<string> {
  const names = new Set<string>();
  // export { a, b as c } from './x'  → exported names are the right-hand side
  for (const match of INDEX_SOURCE.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().replace(/^type\s+/, '');
      if (!name) continue;
      const parts = name.split(/\s+as\s+/);
      names.add(parts[parts.length - 1].trim());
    }
  }
  // Direct declarations exported from index.ts itself (rare).
  for (const match of INDEX_SOURCE.matchAll(
    /export\s+(?:const|class|function|interface|enum)\s+(\w+)/g,
  )) {
    names.add(match[1]);
  }
  return names;
}

describe('QueueModule openness proof', () => {
  const files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.ts'));
  const imports = files.flatMap((f) =>
    parseImports(f, readFileSync(join(QUEUE_DIR, f), 'utf8')),
  );

  it('imports vela only through the public barrel', () => {
    const offenders = imports.filter(
      (imp) => !imp.specifier.startsWith('./') && imp.specifier !== '../index',
    );
    expect(
      offenders.map((o) => `${o.file}: '${o.specifier}'`),
    ).toEqual([]);
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
});
