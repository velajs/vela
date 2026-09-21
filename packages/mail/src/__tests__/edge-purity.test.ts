import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

// The edge-neutrality invariant: `@velajs/mail` core must run on any Web-API
// runtime, so no `node:*` import, no Buffer, no process/__dirname, no timers
// that don't exist on the edge. CF-specific code lives in @velajs/cloudflare.
const FORBIDDEN: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'node:* import', re: /from\s+['"]node:[a-z_/]+['"]/g },
  { name: 'Buffer', re: /(?<![A-Za-z])Buffer(?![A-Za-z])/g },
  {
    name: 'process.*',
    re: /(?<![A-Za-z_.])process\.(env|exit|on|argv|cwd|hrtime|nextTick|stdout|stderr|stdin)\b/g,
  },
  { name: '__dirname', re: /(?<![A-Za-z_])__dirname\b/g },
  { name: '__filename', re: /(?<![A-Za-z_])__filename\b/g },
  { name: "import 'fs'", re: /from\s+['"]fs(\/[a-z]+)?['"]/g },
  { name: "import 'path'", re: /from\s+['"]path['"]/g },
  { name: 'setInterval', re: /(?<![A-Za-z_.])setInterval\s*\(/g },
];

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...(await listTsFiles(p)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    out.push(p);
  }
  return out;
}

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

async function reachable(entry: string): Promise<{ files: string[]; specs: Set<string> }> {
  const seen = new Set<string>();
  const specs = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = await readFile(file, 'utf8');
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1]!;
      specs.add(spec);
      if (spec.startsWith('.')) {
        const r = await resolveRelative(dirname(file), spec);
        if (r) stack.push(r);
      }
    }
  }
  return { files: [...seen], specs };
}

describe('edge purity', () => {
  it('no src file uses a forbidden runtime API', async () => {
    const files = await listTsFiles(SRC);
    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const { name, re } of FORBIDDEN) {
        re.lastIndex = 0;
        if (re.test(stripped)) violations.push(`${file.slice(SRC.length + 1)}: ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('subpath purity', () => {
  it('the catcher transport never reaches @velajs/vela', async () => {
    const { specs } = await reachable(join(SRC, 'transports/catcher/index.ts'));
    expect([...specs].filter((s) => s.startsWith('@velajs/vela'))).toEqual([]);
  });

  it('the resend transport never reaches @velajs/vela', async () => {
    const { specs } = await reachable(join(SRC, 'transports/resend/index.ts'));
    expect([...specs].filter((s) => s.startsWith('@velajs/vela'))).toEqual([]);
  });

  it('the /testing subpath never reaches @velajs/vela or vitest', async () => {
    const { specs } = await reachable(join(SRC, 'testing/index.ts'));
    expect([...specs].filter((s) => s.startsWith('@velajs/vela'))).toEqual([]);
    expect([...specs].filter((s) => s === 'vitest' || s === 'expect')).toEqual([]);
  });
});
