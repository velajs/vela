import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Enforcement of rule #1. Ported verbatim from @velajs/vela's audit and
// EXTENDED with browser-only globals — @velajs/storage is the first package to
// ship browser code (`src/client`), so server (non-opt-in) files must not
// reference DOM-only globals that don't exist on the edge/server.

const SRC_ROOT = join(process.cwd(), 'src');

const FORBIDDEN = [
  { name: 'node:* import', re: /from\s+['"]node:[a-z_]+['"]/g },
  { name: 'Buffer', re: /(?<![A-Za-z])Buffer(?![A-Za-z])/g },
  {
    name: 'process.*',
    re: /(?<![A-Za-z_])process\.(env|exit|on|argv|cwd|hrtime|nextTick|stdout|stderr|stdin)\b/g,
  },
  { name: '__dirname', re: /(?<![A-Za-z_])__dirname\b/g },
  { name: '__filename', re: /(?<![A-Za-z_])__filename\b/g },
  { name: "import 'fs'", re: /from\s+['"]fs(\/[a-z]+)?['"]/g },
  { name: "import 'path'", re: /from\s+['"]path['"]/g },
  { name: "import 'os'", re: /from\s+['"]os['"]/g },
  { name: "import 'child_process'", re: /from\s+['"]child_process['"]/g },
  { name: 'setInterval', re: /(?<![A-Za-z_])setInterval\s*\(/g },
  { name: 'Bun.serve()', re: /(?<![A-Za-z_])Bun\.serve\b/g },
  // Browser-only globals — forbidden in server (non-opt-in) files.
  { name: 'window', re: /(?<![A-Za-z_.])window\b/g },
  { name: 'document', re: /(?<![A-Za-z_.])document\b/g },
  { name: 'XMLHttpRequest', re: /(?<![A-Za-z_.])XMLHttpRequest\b/g },
  { name: 'localStorage', re: /(?<![A-Za-z_.])localStorage\b/g },
  { name: 'sessionStorage', re: /(?<![A-Za-z_.])sessionStorage\b/g },
  { name: 'navigator', re: /(?<![A-Za-z_.])navigator\b/g },
  { name: 'location', re: /(?<![A-Za-z_.])location\b/g },
];

// Subtrees excused from the audit. `client` is browser code (not edge code);
// reserve `node` for a future opt-in native fs driver. `storagesdk` stays
// audited — its bridge is type-only and must never pull a value import.
const ALLOWED_OPTIN_PATHS: string[] = ['client', 'node'];

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
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue;
    out.push(p);
  }
  return out;
}

function isOptIn(filePath: string): boolean {
  const rel = filePath.slice(SRC_ROOT.length + 1).replaceAll('\\', '/');
  return ALLOWED_OPTIN_PATHS.some((p) => rel.startsWith(`${p}/`) || rel === p);
}

describe('edge-runtime audit', () => {
  it('server source has no forbidden runtime APIs', async () => {
    const files = (await listTsFiles(SRC_ROOT)).filter((f) => !isOptIn(f));
    const violations: string[] = [];

    for (const file of files) {
      const content = await readFile(file, 'utf8');
      const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const { name, re } of FORBIDDEN) {
        re.lastIndex = 0;
        if (re.test(stripped)) {
          violations.push(`${file.slice(SRC_ROOT.length + 1)}: ${name}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
