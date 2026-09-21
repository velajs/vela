import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC_ROOT = join(process.cwd(), 'src');
const FORBIDDEN = [
  // node:* imports
  { name: 'node:* import', re: /from\s+['"]node:[a-z_]+['"]/g },
  // Buffer (excluding ArrayBuffer / SharedArrayBuffer)
  { name: 'Buffer', re: /(?<![A-Za-z])Buffer(?![A-Za-z])/g },
  // process.env / process.exit / process.on / etc.
  {
    name: 'process.*',
    re: /(?<![A-Za-z_])process\.(env|exit|on|argv|cwd|hrtime|nextTick|stdout|stderr|stdin)\b/g,
  },
  // __dirname / __filename
  { name: '__dirname', re: /(?<![A-Za-z_])__dirname\b/g },
  { name: '__filename', re: /(?<![A-Za-z_])__filename\b/g },
  // Bare imports of forbidden node built-ins
  { name: "import 'fs'", re: /from\s+['"]fs(\/[a-z]+)?['"]/g },
  { name: "import 'path'", re: /from\s+['"]path['"]/g },
  { name: "import 'os'", re: /from\s+['"]os['"]/g },
  { name: "import 'child_process'", re: /from\s+['"]child_process['"]/g },
  // setInterval is isolated to the opt-in Node scheduling adapter.
  { name: 'setInterval', re: /(?<![A-Za-z_])setInterval\s*\(/g },
  // Bun-only global server APIs
  { name: 'Bun.serve()', re: /(?<![A-Za-z_])Bun\.serve\b/g },
];

// Subtree paths (relative to src) that are explicitly opt-in for Node/Bun
// callers and may legitimately reference Node-only APIs.
const ALLOWED_OPTIN_PATHS = ['schedule-node'];

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...(await listTsFiles(p)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue;
    out.push(p);
  }
  return out;
}

function isOptIn(filePath: string): boolean {
  const rel = filePath.slice(SRC_ROOT.length + 1).replaceAll('\\', '/');
  return ALLOWED_OPTIN_PATHS.some((p) => rel.startsWith(p + '/') || rel === p);
}

describe('edge-runtime audit', () => {
  it('core source has no forbidden runtime APIs', async () => {
    const files = (await listTsFiles(SRC_ROOT)).filter((f) => !isOptIn(f));
    const violations: string[] = [];

    for (const file of files) {
      const content = await readFile(file, 'utf8');
      // Strip line + block comments so banned tokens in docs don't trip the scan.
      const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

      for (const { name, re } of FORBIDDEN) {
        re.lastIndex = 0;
        if (re.test(stripped)) {
          const rel = file.slice(SRC_ROOT.length + 1);
          violations.push(`${rel}: ${name}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
