#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const requestedPaths = process.argv.slice(2);
const lockPaths = requestedPaths.length > 0 ? requestedPaths : ['pnpm-lock.yaml'];

let violations = 0;

function report(filePath, message) {
  console.error(filePath + ': ' + message);
  violations += 1;
}

function unquoteYamlKey(value) {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function escapesWorkspace(rootPath, basePath, linkTarget) {
  if (/^(?:\/|[A-Za-z]:[\\/])/u.test(linkTarget)) return true;
  const targetPath = resolve(basePath, linkTarget);
  const relativePath = relative(rootPath, targetPath);
  return relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath);
}

function inspectLinks(filePath, lines) {
  const rootPath = dirname(filePath);
  let section;
  let importerPath = '.';

  lines.forEach((line, index) => {
    const sectionMatch = /^(\S[^:]*):\s*$/u.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1];
      return;
    }

    for (const linkMatch of line.matchAll(/\blink:([^\s'",}\]]+)/gu)) {
      const target = linkMatch[1];
      if (target !== undefined && /^(?:\/|[A-Za-z]:[\\/])/u.test(target)) {
        report(
          filePath,
          'line ' + (index + 1) + ' contains a non-portable absolute link dependency',
        );
      }
    }

    if (section === 'importers') {
      const importerMatch = /^  (\S.*):\s*$/u.exec(line);
      if (importerMatch !== null) {
        importerPath = unquoteYamlKey(importerMatch[1]);
        return;
      }
      const valueMatch = /^\s+(?:specifier|version):\s*['"]?(link:[^\s'"]+)/u.exec(line);
      if (valueMatch !== null) {
        const target = valueMatch[1].slice('link:'.length);
        if (
          !/^(?:\/|[A-Za-z]:[\\/])/u.test(target) &&
          escapesWorkspace(rootPath, resolve(rootPath, importerPath), target)
        ) {
          report(
            filePath,
            'importer "' +
              importerPath +
              '" links outside the repository; use registry metadata for release locks',
          );
        }
      }
    } else if (section === 'overrides') {
      const valueMatch = /:\s*['"]?(link:[^\s'"]+)['"]?\s*$/u.exec(line);
      if (valueMatch !== null) {
        const target = valueMatch[1].slice('link:'.length);
        if (
          !/^(?:\/|[A-Za-z]:[\\/])/u.test(target) &&
          escapesWorkspace(rootPath, rootPath, target)
        ) {
          report(
            filePath,
            'override links outside the repository; use registry metadata for release locks',
          );
        }
      }
    }
  });
}

function inspectLockfile(inputPath) {
  const filePath = resolve(inputPath);
  let contents;

  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (error) {
    report(filePath, 'could not be read: ' + error.message);
    return;
  }

  const lines = contents.split(/\r?\n/u);
  inspectLinks(filePath, lines);
  const packagesStart = lines.findIndex((line) => line === 'packages:');
  if (packagesStart < 0) {
    report(filePath, 'does not contain a packages section');
    return;
  }

  const entries = [];
  let current;

  const finishEntry = () => {
    if (current !== undefined) {
      entries.push(current);
      current = undefined;
    }
  };

  for (let index = packagesStart + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.length > 0 && !line.startsWith(' ')) {
      break;
    }

    const entryMatch = /^  (\S.*):\s*$/u.exec(line);
    if (entryMatch !== null) {
      finishEntry();
      current = {
        key: unquoteYamlKey(entryMatch[1]),
        lines: [],
      };
      continue;
    }

    if (current !== undefined) {
      current.lines.push(line);
    }
  }
  finishEntry();

  for (const entry of entries) {
    const resolutionIndex = entry.lines.findIndex((line) => line.startsWith('    resolution:'));

    if (resolutionIndex < 0) {
      report(
        filePath,
        'registry snapshot "' +
          entry.key +
          '" is missing resolution metadata. Do not handcraft it; publish the upstream package and regenerate this lockfile from the registry.',
      );
      continue;
    }

    const resolutionLines = [entry.lines[resolutionIndex]];
    for (let index = resolutionIndex + 1; index < entry.lines.length; index += 1) {
      const line = entry.lines[index];
      if (/^    \S/u.test(line)) {
        break;
      }
      resolutionLines.push(line);
    }

    const resolution = resolutionLines.join('\n');
    const isLocal =
      /(?:^|@)(?:file|link):/u.test(entry.key) ||
      /\b(?:directory|tarball):\s*(?:file:|\.\.?\/|\/)/u.test(resolution);
    const isPinnedGit =
      /\brepo:\s*[^,}\s]+/u.test(resolution) && /\bcommit:\s*[^,}\s]+/u.test(resolution);

    if (!isLocal && !isPinnedGit && !/\bintegrity:\s*[^,}\s]+/u.test(resolution)) {
      report(
        filePath,
        'registry snapshot "' +
          entry.key +
          '" lacks an integrity-bearing resolution. Do not invent an integrity hash; publish the upstream package and regenerate this lockfile from the registry.',
      );
    }
  }
}

for (const lockPath of lockPaths) {
  inspectLockfile(lockPath);
}

if (violations > 0) {
  console.error(
    'Release lock preflight failed with ' +
      violations +
      ' violation' +
      (violations === 1 ? '' : 's') +
      '.',
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    'Release lock preflight passed for ' +
      lockPaths.length +
      ' lockfile' +
      (lockPaths.length === 1 ? '' : 's') +
      '.\n',
  );
}
