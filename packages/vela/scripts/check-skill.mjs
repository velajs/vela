#!/usr/bin/env node
// Validates the @velajs/vela agent skill (.agents/skills/vela).
//
// Require matching package metadata, valid public subpaths, and complete,
// Git-tracked reference documentation.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const skillDir = join(repoRoot, '.agents', 'skills', 'vela');
const skillPath = join(skillDir, 'SKILL.md');
const pkgPath = join(repoRoot, 'package.json');

const errors = [];

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

// --- 2. Reference Loading Guide doc paths ------------------------------------
// References must be present in a clean checkout, not only on a local machine.
const docPaths = new Set();
for (const m of skill.matchAll(/`(references\/[\w.-]+\.md|assets\/[\w.-]+\.md)`/g)) {
  docPaths.add(m[1]);
}

// True when `path` is committed or staged (tracked) in git; false otherwise.
function isGitTracked(absPath) {
  const relPath = relative(repoRoot, absPath);
  try {
    const out = execFileSync('git', ['ls-files', '--', relPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return out.trim().length > 0;
  } catch (err) {
    errors.push(`could not verify git tracking for ${relPath}: ${err.message}`);
    return true; // don't double-report as untracked when git itself failed
  }
}

for (const rel of [...docPaths].sort()) {
  const abs = join(skillDir, rel);
  if (!existsSync(abs)) {
    errors.push(`referenced doc not found: ${rel}`);
    continue;
  }
  if (!isGitTracked(abs)) {
    errors.push(
      `reference doc exists but is NOT git-tracked: ${rel}; add it to Git so the skill ships with its references.`,
    );
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
if (errors.length) {
  console.error('check-skill: FAILED:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `check-skill: OK — version ${pkgVersion}; ` +
    `${docPaths.size} reference docs verified; ` +
    `${subpaths.size} subpaths verified against package.json#exports.`,
);
