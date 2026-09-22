import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A separate required CI gate: the ordinary unit suite may run without a database.
const connection = process.env.VELA_POSTGRES_URL;
if (!connection) {
  console.error('VELA_POSTGRES_URL is required for live PostgreSQL tests.');
  process.exit(1);
}
try {
  const url = new URL(connection);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error();
} catch {
  console.error('VELA_POSTGRES_URL must be a PostgreSQL connection URL.');
  process.exit(1);
}

const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', '--config', 'tests/crud/vitest.config.ts', 'postgres'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit' },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
