#!/usr/bin/env node
// Validates the @velajs/vela agent skill (.agents/skills/vela).
//
// Behavior (chosen per task brief):
//   - HARD FAIL (exit 1) on:
//       * metadata.version in SKILL.md != package.json version
//       * a "@velajs/vela/<subpath>" mentioned in SKILL.md that is NOT in
//         package.json#exports
//       * missing/unparseable SKILL.md frontmatter or version
//   - WARN ONLY (exit 0) for reference/asset docs listed in the SKILL.md
//     Reference Loading Guide that do not yet exist on disk — the ecosystem
//     references (testing, cloudflare, crud, auth, ...) are landed by a sibling
//     task (C1b), so their absence must not fail this check until then.
//
// The Reference Loading Guide table is the shared contract between the core
// skill task and the ecosystem-references task; this script enforces the
// version/subpath invariants both must respect.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const skillDir = join(repoRoot, '.agents', 'skills', 'vela');
const skillPath = join(skillDir, 'SKILL.md');
const pkgPath = join(repoRoot, 'package.json');

const errors = [];
const warnings = [];

function fail(msg) {
  console.error(`check-skill: ${msg}`);
  process.exit(1);
}

if (!existsSync(skillPath)) fail(`SKILL.md not found at ${skillPath}`);
if (!existsSync(pkgPath)) fail(`package.json not found at ${pkgPath}`);

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const pkgVersion = pkg.version;
const exportKeys = new Set(Object.keys(pkg.exports ?? {}));

const skill = readFileSync(skillPath, 'utf8');

// --- 1. Frontmatter + version -------------------------------------------------
const fmMatch = skill.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) {
  errors.push('SKILL.md is missing YAML frontmatter (--- ... ---).');
} else {
  const frontmatter = fmMatch[1];
  const versionMatch = frontmatter.match(/version:\s*["']?([^"'\n]+?)["']?\s*$/m);
  const skillVersion = versionMatch ? versionMatch[1].trim() : undefined;
  if (!skillVersion) {
    errors.push('metadata.version not found in SKILL.md frontmatter.');
  } else if (skillVersion !== pkgVersion) {
    errors.push(
      `Version mismatch: SKILL.md metadata.version="${skillVersion}" but package.json version="${pkgVersion}".`,
    );
  }
}

// --- 2. Reference Loading Guide doc paths (warn if missing) -------------------
const docPaths = new Set();
for (const m of skill.matchAll(/`(references\/[\w.-]+\.md|assets\/[\w.-]+\.md)`/g)) {
  docPaths.add(m[1]);
}
let missing = 0;
for (const rel of [...docPaths].sort()) {
  if (!existsSync(join(skillDir, rel))) {
    missing += 1;
    warnings.push(`referenced doc not found yet (sibling task may add it): ${rel}`);
  }
}

// --- 3. Subpaths mentioned in SKILL.md must exist in package.json#exports -----
const subpaths = new Set();
for (const m of skill.matchAll(/@velajs\/vela\/([\w-]+)/g)) subpaths.add(m[1]);
for (const sp of [...subpaths].sort()) {
  const key = `./${sp}`;
  if (!exportKeys.has(key)) {
    errors.push(
      `SKILL.md references subpath "@velajs/vela/${sp}" but package.json#exports has no "${key}".`,
    );
  }
}

// --- Report ------------------------------------------------------------------
if (warnings.length) {
  console.warn('check-skill: warnings:');
  for (const w of warnings) console.warn(`  - ${w}`);
}
if (errors.length) {
  console.error('check-skill: FAILED:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `check-skill: OK — version ${pkgVersion}; ` +
    `${docPaths.size} docs referenced (${missing} pending sibling task); ` +
    `${subpaths.size} subpaths verified against package.json#exports.`,
);
