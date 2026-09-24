import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The QueueModule is the roadmap's "openness proof": a whole feature module
 * authored on the PUBLIC API alone. It imports the rest of vela through the
 * leaf modules that declare each symbol (so the subpath never loads the root
 * barrel), and this audit machine-verifies the claim:
 *
 * 1. every vela import in src/queue/* is intra-module or a vela leaf module —
 *    no other package;
 * 2. every symbol imported from a leaf module is exported by a public entry
 *    (the root app kit, `@velajs/vela/module-kit` or a feature subpath), so an
 *    external author could write the same module against '@velajs/vela'
 *    verbatim — nothing comes from `/internal`; and
 * 3. every value imported from a leaf is the same binding the public entry
 *    exports.
 */
const QUEUE_DIR = join(__dirname, '..', 'queue');

const SRC = join(__dirname, '..');
const MANIFEST = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
  exports: Record<string, { import: string }>;
};

interface ParsedImport {
  file: string;
  specifier: string;
  symbols: { name: string; type: boolean }[];
}

function parseImports(file: string, source: string): ParsedImport[] {
  const out: ParsedImport[] = [];
  // Covers `import { a, b } from 'x'`, `import type { a } from 'x'`, and
  // `type X` / `X as Y` inside a clause: the imported name is the left side.
  const importRe = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importRe)) {
    const symbols = match[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({
        name: s
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          .trim(),
        type: Boolean(match[1]) || s.startsWith('type '),
      }));
    out.push({ file, specifier: match[3], symbols });
  }
  return out;
}

/** Source file behind each public `@velajs/vela` entry (package.json#exports). */
function publicEntrySources(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [subpath, target] of Object.entries(MANIFEST.exports)) {
    entries.set(
      subpath,
      join(SRC, '..', target.import.replace('./dist/', 'src/').replace(/\.js$/, '.ts')),
    );
  }
  return entries;
}

/** Names each entry exports, read from its `export { … }` clauses. */
function exportedNames(entrySource: string): Set<string> {
  const text = readFileSync(entrySource, 'utf8');
  const names = new Set<string>();
  for (const match of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().replace(/^type\s+/, '');
      if (!name) continue;
      const parts = name.split(/\s+as\s+/);
      names.add(parts[parts.length - 1].trim());
    }
  }
  return names;
}

/**
 * The public home of each name another module may build on: the root app kit,
 * `/module-kit` and the feature subpaths. `/internal` is framework plumbing and
 * never counts.
 */
function publicHomes(ownSubpath: string) {
  const homes = new Map<string, string>();
  for (const [subpath, source] of publicEntrySources()) {
    if (subpath === ownSubpath || subpath === './internal') continue;
    for (const name of exportedNames(source)) homes.set(name, subpath);
  }
  return homes;
}

describe('QueueModule openness proof', () => {
  const files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.ts'));
  const imports = files.flatMap((f) => parseImports(f, readFileSync(join(QUEUE_DIR, f), 'utf8')));
  const leafImports = imports.filter((imp) => imp.specifier.startsWith('../'));

  it('imports vela only through its own leaf modules', () => {
    const offenders = imports.filter(
      (imp) => !imp.specifier.startsWith('./') && !imp.specifier.startsWith('../'),
    );
    expect(offenders.map((o) => `${o.file}: '${o.specifier}'`)).toEqual([]);
    const barrels = leafImports.filter((imp) =>
      /^\.\.\/(index|internal|module-kit)$/.test(imp.specifier),
    );
    expect(barrels.map((o) => `${o.file}: '${o.specifier}'`)).toEqual([]);
  });

  it('uses only symbols a public entry exports', () => {
    const homes = publicHomes('./queue');
    const missing = leafImports.flatMap((imp) =>
      imp.symbols.filter((s) => !homes.has(s.name)).map((s) => `${imp.file}: ${s.name}`),
    );
    expect(missing).toEqual([]);
  });

  it('imports the same bindings the public entries export', async () => {
    const homes = publicHomes('./queue');
    const sources = publicEntrySources();
    const mismatched: string[] = [];
    for (const imp of leafImports) {
      const leaf = (await import(resolve(QUEUE_DIR, `${imp.specifier}.ts`))) as Record<
        string,
        unknown
      >;
      for (const symbol of imp.symbols.filter((s) => !s.type)) {
        const home = homes.get(symbol.name);
        if (!home) continue;
        const entry = (await import(sources.get(home)!)) as Record<string, unknown>;
        if (entry[symbol.name] !== leaf[symbol.name])
          mismatched.push(`${imp.file}: ${symbol.name}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('covers the whole module (sanity: files and imports were found)', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(leafImports.length).toBeGreaterThan(20);
  });
});
