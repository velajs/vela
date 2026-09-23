import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(__dirname, '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

// Bundlers drop an unused `/* @__PURE__ */` call only when evaluating its
// arguments has no side effects. A member access such as `HttpMethod.GET` may
// run a getter, so esbuild keeps the whole call alive even when annotated.
const ANNOTATED_CALL = /\/\* @__PURE__ \*\/\s*(?:new\s+)?[\w$.]+(?:<[^>()]*>)?\(([^()]*)\)/g;
const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;
const MEMBER_ACCESS = /[\w$)\]]\s*\??\.\s*[A-Za-z_$]/;

describe('pure annotations', () => {
  it('pass only side-effect-free arguments to annotated calls', () => {
    const offending: string[] = [];
    let annotated = 0;
    for (const file of sourceFiles(SRC_ROOT)) {
      for (const match of readFileSync(file, 'utf8').matchAll(ANNOTATED_CALL)) {
        annotated += 1;
        const args = (match[1] ?? '').replace(STRING_LITERAL, "''");
        if (MEMBER_ACCESS.test(args)) offending.push(`${relative(SRC_ROOT, file)}: ${match[0]}`);
      }
    }
    expect(annotated).toBeGreaterThan(0);
    expect(offending).toEqual([]);
  });
});
