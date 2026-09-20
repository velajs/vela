#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const distDirectory = resolve(repositoryRoot, 'dist');
const snapshotDirectory = resolve(repositoryRoot, 'api-snapshots');
const snapshotPath = resolve(snapshotDirectory, 'vela.api.md');
const manifestPath = resolve(repositoryRoot, 'package.json');
const mode = process.argv[2] ?? 'check';

if (mode !== 'check' && mode !== 'update') {
  fail(`unknown mode "${mode}"; use "check" or "update"`);
}

function fail(message) {
  process.stderr.write(`api-snapshot: ${message}\n`);
  process.exit(1);
}

function isInside(parentPath, candidatePath) {
  const pathFromParent = relative(parentPath, candidatePath);
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== '..' &&
      !isAbsolute(pathFromParent))
  );
}

const declarationTargetPattern = /\.d\.(?:ts|mts|cts)$/u;

function collectTypeTargets(exportValue, conditions = [], targets = []) {
  if (typeof exportValue === 'string') {
    if (declarationTargetPattern.test(exportValue)) {
      targets.push({ conditions, target: exportValue });
    }
    return targets;
  }

  if (Array.isArray(exportValue)) {
    exportValue.forEach((nestedValue, index) => {
      collectTypeTargets(nestedValue, [...conditions, `[${index}]`], targets);
    });
    return targets;
  }

  if (exportValue === null || typeof exportValue !== 'object') {
    return targets;
  }

  for (const [condition, nestedValue] of Object.entries(exportValue)) {
    collectTypeTargets(nestedValue, [...conditions, condition], targets);
  }

  return targets;
}

function typeTargetsForExport(exportValue) {
  const conditionsByTarget = new Map();

  for (const { conditions, target } of collectTypeTargets(exportValue)) {
    const label = conditions.length === 0 ? 'default' : conditions.join('.').replaceAll('.[', '[');
    const targetConditions = conditionsByTarget.get(target) ?? new Set();
    targetConditions.add(label);
    conditionsByTarget.set(target, targetConditions);
  }

  return [...conditionsByTarget]
    .map(([target, conditions]) => ({ conditions: [...conditions].toSorted(), target }))
    .toSorted((left, right) => {
      const targetComparison = left.target.localeCompare(right.target);
      if (targetComparison !== 0) return targetComparison;
      return left.conditions.join('|').localeCompare(right.conditions.join('|'));
    });
}

function compareSubpaths(left, right) {
  if (left === right) return 0;
  if (left === '.') return -1;
  if (right === '.') return 1;
  return left.localeCompare(right);
}

function collectPublicEntries() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const exportsMap = manifest.exports;

  if (exportsMap === null || typeof exportsMap !== 'object' || Array.isArray(exportsMap)) {
    fail('package.json must contain an object-valued exports map');
  }

  return Object.entries(exportsMap)
    .toSorted(([left], [right]) => compareSubpaths(left, right))
    .flatMap(([subpath, exportValue]) => {
      const typeTargets = typeTargetsForExport(exportValue);
      if (typeTargets.length === 0) {
        fail(`package export "${subpath}" has no declaration target`);
      }

      return typeTargets.map(({ conditions, target }) => {
        const declarationPath = resolve(repositoryRoot, target);
        if (!isInside(distDirectory, declarationPath)) {
          fail(`package export "${subpath}" points outside dist/: ${target}`);
        }
        if (!existsSync(declarationPath)) {
          fail(`built declaration ${target} is missing; run \`pnpm build\` first`);
        }

        return { conditions, declarationPath, subpath, target };
      });
    });
}

const declarationReferencePatterns = [
  /\bfrom\s*(["'])(\.\.?\/[^"']+)\1/gu,
  /\bimport\s*\(\s*(["'])(\.\.?\/[^"']+)\1\s*\)/gu,
  /^\s*import\s*(["'])(\.\.?\/[^"']+)\1/gmu,
  /^\s*\/\/\/\s*<reference\s+(?:path|types)=(["'])(\.\.?\/[^"']+)\1/gmu,
];

function declarationReferences(contents) {
  const references = new Set();

  for (const pattern of declarationReferencePatterns) {
    pattern.lastIndex = 0;
    for (const match of contents.matchAll(pattern)) {
      references.add(match[2]);
    }
  }

  return [...references].toSorted();
}

function declarationCandidates(importPath) {
  const extension = extname(importPath);
  if (extension === '.js') return [`${importPath.slice(0, -3)}.d.ts`];
  if (extension === '.mjs') return [`${importPath.slice(0, -4)}.d.mts`];
  if (extension === '.cjs') return [`${importPath.slice(0, -4)}.d.cts`];
  if (
    importPath.endsWith('.d.ts') ||
    importPath.endsWith('.d.mts') ||
    importPath.endsWith('.d.cts')
  ) {
    return [importPath];
  }
  if (extension === '') return [`${importPath}.d.ts`, resolve(importPath, 'index.d.ts')];
  return [];
}

function resolveDeclarationReference(importerPath, specifier) {
  const unresolvedPath = resolve(dirname(importerPath), specifier);

  for (const candidatePath of declarationCandidates(unresolvedPath)) {
    if (existsSync(candidatePath)) {
      if (!isInside(distDirectory, candidatePath)) {
        fail(
          `${relative(repositoryRoot, importerPath)} references a declaration outside dist/: ${specifier}`,
        );
      }
      return candidatePath;
    }
  }

  fail(
    `${relative(repositoryRoot, importerPath)} has an unresolved local declaration reference: ${specifier}`,
  );
}

function collectDeclarationGraph(publicEntries) {
  const contentsByPath = new Map();
  const referencesByPath = new Map();
  const pending = publicEntries.map(({ declarationPath }) => declarationPath);

  while (pending.length > 0) {
    const declarationPath = pending.shift();
    if (contentsByPath.has(declarationPath)) continue;

    const contents = readFileSync(declarationPath, 'utf8').replaceAll('\r\n', '\n');
    const references = new Map();

    for (const specifier of declarationReferences(contents)) {
      const referencedPath = resolveDeclarationReference(declarationPath, specifier);
      references.set(specifier, referencedPath);
      pending.push(referencedPath);
    }

    contentsByPath.set(declarationPath, contents);
    referencesByPath.set(declarationPath, references);
  }

  return { contentsByPath, referencesByPath };
}

function firstSourceRegion(contents) {
  const match = /^\/\/#region\s+(.+)$/mu.exec(contents);
  return match?.[1]
    .replace(/^src\//u, '')
    .replace(/\.d\.(?:ts|mts|cts)$/u, '')
    .replaceAll(/[^A-Za-z0-9._-]+/gu, '-')
    .replaceAll(/^-|-$/gu, '');
}

function withoutChunkHash(fileName) {
  return fileName.replace(/-[A-Za-z0-9_-]{8}(?=\.d\.(?:ts|mts|cts)$)/u, '');
}

function canonicalNames(publicEntries, contentsByPath) {
  const names = new Map();
  const publicPaths = new Set();
  const entriesByPath = new Map();

  for (const { conditions, declarationPath, subpath } of publicEntries) {
    publicPaths.add(declarationPath);
    const entryNames = entriesByPath.get(declarationPath) ?? [];
    entryNames.push(`${subpath}@${conditions.join('|')}`);
    entriesByPath.set(declarationPath, entryNames);
  }

  for (const [declarationPath, entryNames] of entriesByPath) {
    names.set(declarationPath, `entry:${entryNames.toSorted().join(',')}`);
  }

  const internalPaths = [...contentsByPath.keys()].filter((path) => !publicPaths.has(path));
  const pathsByBaseName = new Map();

  for (const declarationPath of internalPaths) {
    const relativePath = relative(distDirectory, declarationPath).split(sep).join('/');
    const baseName = withoutChunkHash(relativePath);
    const matchingPaths = pathsByBaseName.get(baseName) ?? [];
    matchingPaths.push(declarationPath);
    pathsByBaseName.set(baseName, matchingPaths);
  }

  for (const [baseName, matchingPaths] of [...pathsByBaseName].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (matchingPaths.length === 1) {
      names.set(matchingPaths[0], `internal:${baseName}`);
      continue;
    }

    const identifiedPaths = matchingPaths
      .map((declarationPath) => ({
        declarationPath,
        region: firstSourceRegion(contentsByPath.get(declarationPath)) ?? 'unknown',
      }))
      .toSorted((left, right) => left.region.localeCompare(right.region));

    const usedNames = new Set();
    for (const { declarationPath, region } of identifiedPaths) {
      let canonicalName = `internal:${baseName.replace(/\.d\.(?:ts|mts|cts)$/u, '')}-${region}.d.ts`;
      let duplicate = 2;
      while (usedNames.has(canonicalName)) {
        canonicalName = `internal:${baseName.replace(/\.d\.(?:ts|mts|cts)$/u, '')}-${region}-${duplicate}.d.ts`;
        duplicate += 1;
      }
      usedNames.add(canonicalName);
      names.set(declarationPath, canonicalName);
    }
  }

  return names;
}

function stripComments(contents) {
  let output = '';
  let state = 'code';

  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    const nextCharacter = contents[index + 1];

    if (state === 'line-comment') {
      if (character === '\n') {
        output += character;
        state = 'code';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (character === '*' && nextCharacter === '/') {
        state = 'code';
        index += 1;
      } else if (character === '\n') {
        output += character;
      }
      continue;
    }

    if (state !== 'code') {
      output += character;
      if (character === '\\') {
        if (nextCharacter !== undefined) {
          output += nextCharacter;
          index += 1;
        }
      } else if (character === state) {
        state = 'code';
      }
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      const lineEnd = contents.indexOf('\n', index);
      const end = lineEnd === -1 ? contents.length : lineEnd;
      const remainder = contents.slice(index, end);
      if (/^\/\/\/\s*<reference\b/u.test(remainder)) {
        // Triple-slash references affect the consumer's type environment and
        // are semantic declaration input, not documentation comments.
        output += remainder;
        index = end - 1;
      } else {
        state = 'line-comment';
        index += 1;
      }
    } else if (character === '/' && nextCharacter === '*') {
      const commentEnd = contents.indexOf('*/', index + 2);
      if (commentEnd === -1) {
        state = 'block-comment';
        index += 1;
        continue;
      }

      const comment = contents.slice(index, commentEnd + 2);
      if (comment.startsWith('/**')) {
        const semanticTags = new Set();
        const tagPattern =
          /(?:^|\n)[ \t]*\*?[ \t]*@(alpha|beta|deprecated|experimental|internal|public)\b/gu;
        for (const match of comment.slice(3, -2).matchAll(tagPattern)) {
          semanticTags.add(match[1]);
        }
        if (semanticTags.size > 0) {
          output += `/** ${[...semanticTags]
            .toSorted()
            .map((tag) => `@${tag}`)
            .join(' ')} */`;
        }
      }
      index = commentEnd + 1;
    } else {
      output += character;
      if (character === "'" || character === '"' || character === '`') state = character;
    }
  }

  return output;
}

function canonicalizeDeclaration(declarationPath, contents, referencesByPath, namesByPath) {
  let canonical = contents;

  for (const [specifier, referencedPath] of referencesByPath.get(declarationPath)) {
    const canonicalReference = `<${namesByPath.get(referencedPath)}>`;
    canonical = canonical.replaceAll(`"${specifier}"`, `"${canonicalReference}"`);
    canonical = canonical.replaceAll(`'${specifier}'`, `'${canonicalReference}'`);
  }

  // Private and protected declarations remain part of the snapshot: they can
  // change class assignability and constructor/static compatibility in TypeScript.
  const normalizedLines = stripComments(canonical)
    .split('\n')
    .map((line) => line.trimEnd());
  const compactLines = [];

  for (const line of normalizedLines) {
    if (line === '' && compactLines.at(-1) === '') continue;
    compactLines.push(line);
  }

  while (compactLines.at(-1) === '') compactLines.pop();
  return `${compactLines.join('\n')}\n`;
}

function renderSnapshot() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const publicEntries = collectPublicEntries();
  const { contentsByPath, referencesByPath } = collectDeclarationGraph(publicEntries);
  const namesByPath = canonicalNames(publicEntries, contentsByPath);
  const lines = [
    '# `@velajs/vela` public API',
    '',
    'Generated by `pnpm api:update` from the built declaration graph. Verified by',
    '`pnpm api:check`; do not edit by hand. Documentation comments, content-hashed',
    'chunk names, and line endings are normalized. Private/protected declarations remain',
    'because they can affect TypeScript assignability.',
    '',
    '## Ordered package export map',
    '',
    'Object condition order is resolution-significant, so this tree is kept verbatim.',
    '',
    '```json',
    JSON.stringify(manifest.exports, null, 2),
    '```',
    '',
  ];

  for (const { conditions, declarationPath, subpath, target } of publicEntries) {
    lines.push(
      `## \`${subpath}\``,
      '',
      `Type conditions: ${conditions.map((condition) => `\`${condition}\``).join(', ')}`,
      '',
      `Declaration entry: \`${target}\``,
      '',
      '```ts',
    );
    lines.push(
      canonicalizeDeclaration(
        declarationPath,
        contentsByPath.get(declarationPath),
        referencesByPath,
        namesByPath,
      ).trimEnd(),
    );
    lines.push('```', '');
  }

  const publicPaths = new Set(publicEntries.map(({ declarationPath }) => declarationPath));
  const internalPaths = [...contentsByPath.keys()]
    .filter((path) => !publicPaths.has(path))
    .toSorted((left, right) => namesByPath.get(left).localeCompare(namesByPath.get(right)));

  if (internalPaths.length > 0) {
    lines.push('## Referenced declaration chunks', '');
  }

  for (const declarationPath of internalPaths) {
    lines.push(`### \`<${namesByPath.get(declarationPath)}>\``, '', '```ts');
    lines.push(
      canonicalizeDeclaration(
        declarationPath,
        contentsByPath.get(declarationPath),
        referencesByPath,
        namesByPath,
      ).trimEnd(),
    );
    lines.push('```', '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function printDiff(committed, current) {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'vela-api-snapshot-'));
  const committedPath = resolve(temporaryDirectory, 'committed.api.md');
  const currentPath = resolve(temporaryDirectory, 'current.api.md');

  try {
    writeFileSync(committedPath, committed);
    writeFileSync(currentPath, current);
    const result = spawnSync(
      'git',
      ['diff', '--no-index', '--color=never', '--', committedPath, currentPath],
      { encoding: 'utf8' },
    );

    if (result.stdout) {
      const diffLines = result.stdout.split('\n').slice(4);
      const visibleLines = diffLines.slice(0, 160);
      process.stderr.write(`${visibleLines.join('\n')}\n`);
      if (diffLines.length > visibleLines.length) {
        process.stderr.write(
          `... ${diffLines.length - visibleLines.length} more diff lines; run \`pnpm api:update\` and inspect the snapshot diff.\n`,
        );
      }
    }
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

const renderedSnapshot = renderSnapshot();

if (mode === 'update') {
  mkdirSync(snapshotDirectory, { recursive: true });
  writeFileSync(snapshotPath, renderedSnapshot);
  process.stdout.write(
    `api-snapshot: wrote ${relative(repositoryRoot, snapshotPath)} from the public declaration graph\n`,
  );
  process.exit(0);
}

if (!existsSync(snapshotPath)) {
  fail('api-snapshots/vela.api.md is missing; run `pnpm api:update` and review the result');
}

// Git may materialize Markdown as CRLF on Windows. Built declarations and the
// renderer are normalized to LF, so compare the baseline in that form too.
const committedSnapshot = readFileSync(snapshotPath, 'utf8').replaceAll('\r\n', '\n');
if (committedSnapshot !== renderedSnapshot) {
  process.stderr.write('api-snapshot: public API drift detected\n');
  printDiff(committedSnapshot, renderedSnapshot);
  fail('run `pnpm api:update` and commit the reviewed API snapshot change');
}

process.stdout.write('api-snapshot: public API matches api-snapshots/vela.api.md\n');
