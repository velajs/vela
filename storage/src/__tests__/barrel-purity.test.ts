import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the edge/bundle invariant: the `.` entry (contract + module + facade)
// must never transitively import `aws4fetch`, a driver, or the storagesdk
// bridge — so importing `@velajs/storage` alone stays tiny and dependency-free.

const SRC = join(process.cwd(), 'src');
const IMPORT_RE = /(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g;

async function resolveRelative(fromDir: string, spec: string): Promise<string | undefined> {
  const base = resolve(fromDir, spec);
  for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
    try {
      await readFile(cand, 'utf8');
      return cand;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function reachableFiles(entry: string): Promise<string[]> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = await readFile(file, 'utf8');
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        const resolved = await resolveRelative(dirname(file), spec);
        if (resolved) stack.push(resolved);
      }
    }
  }
  return [...seen];
}

describe('barrel purity', () => {
  it('the "." entry never reaches aws4fetch / drivers / storagesdk / @aws-sdk', async () => {
    const files = await reachableFiles(join(SRC, 'index.ts'));
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(SRC.length + 1);
      const src = await readFile(file, 'utf8');
      if (/from\s+['"]aws4fetch['"]/.test(src)) offenders.push(`${rel}: imports aws4fetch`);
      if (/from\s+['"]@storagesdk/.test(src)) offenders.push(`${rel}: imports @storagesdk`);
      if (/from\s+['"]@aws-sdk/.test(src)) offenders.push(`${rel}: imports @aws-sdk`);
      if (/^drivers\//.test(rel)) offenders.push(`${rel}: driver reachable from barrel`);
      if (/^storagesdk\//.test(rel)) offenders.push(`${rel}: bridge reachable from barrel`);
    }
    expect(offenders).toEqual([]);
  });
});
