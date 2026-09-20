import type { SeederResult } from '@velajs/vela/seeder';

/**
 * Render seeder results to a logger and return a process exit code
 * (0 = all ran, 1 = at least one failed). Pure — no I/O beyond the logger.
 */
export function formatSeedResults(
  results: SeederResult[],
  log: (message: string) => void = (m) => console.log(m),
): number {
  if (results.length === 0) {
    log('No seeders found.');
    return 0;
  }

  let failed = 0;
  for (const result of results) {
    if (result.ok) {
      log(`  ✓ ${result.name}`);
    } else {
      failed++;
      log(`  ✗ ${result.name}${result.error ? `: ${errorMessage(result.error)}` : ''}`);
    }
  }

  const total = results.length;
  log(`\n${total - failed}/${total} seeders ran successfully.`);
  return failed > 0 ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Aligned plain-text table. Pure; returns lines. */
export function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}
