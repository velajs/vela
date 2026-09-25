// Typechecks the TypeScript code blocks of the package READMEs and the bundled
// agent skill against the built workspace packages, so documented APIs cannot
// drift from the published declarations.
//
// Each ```ts block compiles as its own module. Examples are often fragments
// that use names declared elsewhere in the text, so diagnostics a fragment
// raises by design (an undeclared name, an unused declaration) are ignored,
// and so is an import of a relative file or of a third-party package the
// workspace does not install. Everything else fails, above all imports of
// missing `@velajs/*` packages, subpaths and exports, and calls that do not
// match a documented signature. Mark a block that shows invalid code on
// purpose with ```ts nocheck.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Diagnostics a documentation fragment raises by design. */
const FRAGMENT_CODES = new Set([
  2304, // Cannot find name: declared elsewhere in the surrounding text.
  2552, // Cannot find name, with a suggestion.
  2503, // Cannot find namespace.
  2448, // Block-scoped variable used before its declaration (fragments out of order).
  2454, // Variable used before being assigned.
  6133, // Declared but never read.
  6192, // All imports unused.
  6196, // Declared but never used.
  6198, // All destructured elements unused.
  7006, // Parameter implicitly has an any type.
  7031, // Binding element implicitly has an any type.
  1375, // Top-level await in a script.
  1378, // Top-level await target.
  2300, // Duplicate identifier: fragments restate a declaration.
  2393, // Duplicate function implementation.
  2451, // Cannot redeclare block-scoped variable.
  1308, // await outside an async function in a fragment body.
  2449, // Class used before its declaration (a module listed before the one it imports).
  18004, // A shorthand property whose value is declared elsewhere.
  18046, // A value derived from a name declared elsewhere is of type unknown.
]);

/**
 * Bindings and variables a Worker declares in wrangler.jsonc, which the
 * examples read from ENV without showing `wrangler types` output.
 */
const DOCUMENT_ENV = `declare namespace Cloudflare {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Env { [binding: string]: any }
}
`;

/** The documents whose code blocks are checked, relative to the repository root. */
export function documents() {
  const packages = readdirSync(join(repoRoot, 'packages'))
    .map((dir) => join('packages', dir, 'README.md'))
    .filter((file) => existsSync(join(repoRoot, file)));
  const skill = join('packages', 'vela', '.agents', 'skills', 'vela');
  const skillFiles = ['SKILL.md', 'references', 'assets'].flatMap((entry) => {
    const path = join(repoRoot, skill, entry);
    if (entry.endsWith('.md')) return [join(skill, entry)];
    return readdirSync(path)
      .filter((file) => file.endsWith('.md'))
      .map((file) => join(skill, entry, file));
  });
  return [...packages, ...skillFiles].toSorted();
}

/** Every ```ts / ```typescript block of a Markdown text, with its first line number. */
export function blocks(markdown) {
  const found = [];
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const open = /^(\s*)(`{3,})(ts|typescript|tsx)(?:\s+(.*))?\s*$/.exec(lines[index]);
    if (!open) continue;
    const [, indent, fence, lang, info = ''] = open;
    const body = [];
    let end = index + 1;
    while (end < lines.length && !lines[end].trim().startsWith(fence)) {
      body.push(lines[end].startsWith(indent) ? lines[end].slice(indent.length) : lines[end]);
      end++;
    }
    if (!/\bnocheck\b/.test(info)) {
      found.push({ line: index + 2, lang, code: body.join('\n') });
    }
    index = end;
  }
  return found;
}

/** Link every workspace package and its third-party dependencies into `modules`. */
function linkModules(modules) {
  const linked = new Set();
  const link = (name, target) => {
    if (linked.has(name)) return;
    linked.add(name);
    mkdirSync(dirname(join(modules, name)), { recursive: true });
    symlinkSync(realpathSync(target), join(modules, name), 'dir');
  };
  const packageDirs = readdirSync(join(repoRoot, 'packages')).map((dir) =>
    join(repoRoot, 'packages', dir),
  );
  for (const dir of packageDirs) {
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    link(JSON.parse(readFileSync(manifestPath, 'utf8')).name, dir);
  }
  const appDirs = readdirSync(join(repoRoot, 'apps')).map((dir) => join(repoRoot, 'apps', dir));
  for (const dir of [...packageDirs, ...appDirs, repoRoot]) {
    const nodeModules = join(dir, 'node_modules');
    if (!existsSync(nodeModules)) continue;
    for (const entry of readdirSync(nodeModules)) {
      if (entry === '.bin' || entry === '.pnpm') continue;
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) {
        for (const scoped of readdirSync(join(nodeModules, entry))) {
          link(`${entry}/${scoped}`, join(nodeModules, entry, scoped));
        }
      } else {
        link(entry, join(nodeModules, entry));
      }
    }
  }
}

/** Keep the leading import declarations of `code` in place and wrap the rest. */
function wrap(code, open, close) {
  const lines = code.split('\n');
  let split = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === '' || line.startsWith('//')) continue;
    if (!/^import\b/.test(line)) break;
    while (index < lines.length && !/;\s*(\/\/.*)?$/.test(lines[index])) index++;
    split = index + 1;
  }
  const imports = split === 0 ? '' : `${lines.slice(0, split).join('\n')}\n`;
  return `${imports}${open} ${lines.slice(split).join('\n')}\n${close}\n`;
}

function compile(work, files) {
  writeFileSync(
    join(work, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        allowImportingTsExtensions: true,
        jsx: 'react-jsx',
        lib: ['ES2024'],
        types: ['@cloudflare/workers-types', '@cloudflare/vitest-plugin/types'],
      },
      files: ['document-env.d.ts', ...files],
    }),
  );
  let result;
  try {
    const output = execFileSync(
      join(repoRoot, 'packages/vela/node_modules/.bin/tsc'),
      ['-p', 'tsconfig.json', '--pretty', 'false'],
      { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    result = { status: 0, output };
  } catch (error) {
    result = {
      status: typeof error.status === 'number' ? error.status : null,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      error,
    };
  }
  return tscDiagnostics(result);
}

/**
 * The diagnostics of the code blocks in a tsc run: `{ status, output, error? }`.
 * Throws when tsc did not run, reported an error outside the blocks (a
 * tsconfig option, a missing `types` entry), or failed without a diagnostic,
 * so the check never passes without typechecking.
 */
export function tscDiagnostics({ status, output, error }) {
  if (status === null) {
    throw new Error(`tsc did not run: ${error?.message ?? 'no exit status'}`, { cause: error });
  }
  const diagnostics = [];
  const outside = [];
  for (const line of output.split('\n')) {
    const text = line.trim();
    const match = /^(block-\d+\.tsx?)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(text);
    if (match) {
      const [, file, row, , code, message] = match;
      diagnostics.push({ file, row: Number(row), code: Number(code), message });
    } else if (/\berror TS\d+:/.test(text)) {
      outside.push(text);
    }
  }
  if (outside.length > 0) {
    throw new Error(`tsc reported errors outside the code blocks:\n${outside.join('\n')}`);
  }
  if (status !== 0 && diagnostics.length === 0) {
    throw new Error(`tsc exited with ${status} without a diagnostic:\n${output}`);
  }
  return diagnostics;
}

// TypeScript reports no semantic diagnostic while any file has a syntax error.
const isSyntax = (code) => code < 2000;

/**
 * Typecheck every block; returns the failures as `file:line: message` strings.
 * A block that does not parse as a module is retried as class members, the
 * usual shape of a method example.
 */
export function checkDocumentBlocks() {
  const work = mkdtempSync(join(tmpdir(), 'vela-doc-blocks-'));
  try {
    linkModules(join(work, 'node_modules'));
    writeFileSync(join(work, 'document-env.d.ts'), DOCUMENT_ENV);
    const sources = new Map();
    let count = 0;
    for (const document of documents()) {
      const markdown = readFileSync(join(repoRoot, document), 'utf8');
      for (const block of blocks(markdown)) {
        const file = `block-${String(++count).padStart(4, '0')}.${block.lang === 'tsx' ? 'tsx' : 'ts'}`;
        // Each block is its own module, so their declarations do not collide.
        writeFileSync(join(work, file), `${block.code}\nexport {};\n`);
        sources.set(file, { document, line: block.line, offset: 0, code: block.code });
      }
    }
    const failures = [];
    const report = (file, row, code, message) => {
      const source = sources.get(file);
      failures.push(
        `${source.document}:${source.line + row - 1 - source.offset}: TS${code} ${message}`,
      );
    };
    // A block that is not a module is retried as class members (a method
    // example), then as a function body (statements that return), with its
    // import declarations kept at the top. Hoisted imports keep their lines:
    // the wrapper opens on the line of the first statement after them.
    const shapes = [
      (code) => `${code}\nexport {};\n`,
      (code) => wrap(code, 'class DocumentationFragment {', '}\nexport {};'),
      (code) => wrap(code, 'export async function documentationFragment() {', '}'),
    ];
    // Grammar errors surface only once no file has a syntax error, so retry
    // until every remaining block parses, each in its next shape.
    let files = [...sources.keys()];
    let diagnostics = compile(work, files);
    for (;;) {
      const unparsed = new Set(diagnostics.filter((d) => isSyntax(d.code)).map((d) => d.file));
      if (unparsed.size === 0) break;
      for (const file of unparsed) {
        const source = sources.get(file);
        source.shape = (source.shape ?? 0) + 1;
        if (source.shape < shapes.length) {
          source.offset = 0;
          writeFileSync(join(work, file), shapes[source.shape](source.code));
          continue;
        }
        for (const d of diagnostics) {
          if (d.file === file && isSyntax(d.code)) report(d.file, d.row, d.code, d.message);
        }
        files = files.filter((candidate) => candidate !== file);
      }
      diagnostics = compile(work, files);
    }
    for (const d of diagnostics) {
      if (FRAGMENT_CODES.has(d.code)) continue;
      // An import of the reader's own files, or of a package the workspace does not install.
      const missing =
        d.code === 2307 ? /Cannot find module '([^']+)'/.exec(d.message)?.[1] : undefined;
      if (missing !== undefined && !missing.startsWith('@velajs/')) continue;
      report(d.file, d.row, d.code, d.message);
    }
    return { count, failures };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'doc-blocks.mjs') {
  const { count, failures } = checkDocumentBlocks();
  for (const failure of failures) console.error(failure);
  console.log(
    `${count} blocks, ${failures.length} failures (${relative(process.cwd(), repoRoot) || '.'})`,
  );
  if (failures.length) process.exit(1);
}
