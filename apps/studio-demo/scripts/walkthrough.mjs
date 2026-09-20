#!/usr/bin/env node
/**
 * Reproducible driver for the end-to-end Studio conformance walkthrough.
 *
 *   pnpm --filter @velajs/studio-demo build   # produce ./dist
 *   node examples/demo/scripts/walkthrough.mjs
 *
 * Boots the whole demo app + the loopback host in-process, drives every admin
 * op + the time-travel round-trip + the 428 confirm flows, prints a per-op pass
 * table, and exits non-zero if any op fails. The same logic backs the vitest
 * e2e (`__tests__/walkthrough.e2e.test.ts`), which is the CI conformance gate.
 */
import { runWalkthrough } from '../dist/walkthrough.js';

const report = await runWalkthrough({ token: 'walkthrough-cli-token' });

const pad = (s, n) => String(s).padEnd(n);
const opWidth = Math.min(48, Math.max(...report.rows.map((r) => r.op.length)));

console.log('\nVela Studio — end-to-end conformance walkthrough\n');
console.log(`${pad('OP', opWidth)}  RESULT  EVIDENCE`);
console.log(`${'-'.repeat(opWidth)}  ------  --------`);
for (const row of report.rows) {
  const mark = row.pass ? 'PASS' : 'FAIL';
  const note = row.pass ? row.evidence : `!! ${row.detail}`;
  console.log(`${pad(row.op, opWidth)}  ${mark}    ${note}`);
}

const passed = report.rows.filter((r) => r.pass).length;
console.log(`\n${passed}/${report.rows.length} operations passed.\n`);

process.exit(report.passed ? 0 : 1);
