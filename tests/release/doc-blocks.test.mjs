import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tscDiagnostics } from '../../packages/vela/scripts/doc-blocks.mjs';

// check:skill passes only when tsc ran and every error belongs to a code block.
test('reads the diagnostics tsc reports for the code blocks', () => {
  assert.deepEqual(
    tscDiagnostics({
      status: 2,
      output:
        "block-0001.ts(3,7): error TS2345: Argument of type 'number' is not assignable.\n" +
        "  Type 'number' is not assignable to type 'string'.\n",
    }),
    [
      {
        file: 'block-0001.ts',
        row: 3,
        code: 2345,
        message: "Argument of type 'number' is not assignable.",
      },
    ],
  );
  assert.deepEqual(tscDiagnostics({ status: 0, output: '' }), []);
});

test('fails when tsc did not run or reported errors outside the blocks', () => {
  assert.throws(
    () => tscDiagnostics({ status: null, output: '', error: new Error('spawn tsc ENOENT') }),
    /tsc did not run: spawn tsc ENOENT/,
  );
  assert.throws(
    () =>
      tscDiagnostics({
        status: 2,
        output: "error TS2688: Cannot find type definition file for '@cloudflare/workers-types'.\n",
      }),
    /outside the code blocks[^]*TS2688/,
  );
  assert.throws(
    () =>
      tscDiagnostics({ status: 1, output: 'tsconfig.json(3,5): error TS5023: Unknown option.\n' }),
    /outside the code blocks[^]*TS5023/,
  );
  assert.throws(() => tscDiagnostics({ status: 1, output: '' }), /exited with 1/);
});
