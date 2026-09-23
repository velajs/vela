import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createOpenApiDocument } from '@velajs/vela';
import { generateClientContract } from '@velajs/cli/client';
import { runnerImport } from 'vite';
import { oxc } from '../oxc.config.ts';

// Vite's module runner compiles src/ with the Worker build's Oxc options, so the
// decorator metadata is read from source without a build step. Packages load
// from node_modules.
const { module } = await runnerImport(fileURLToPath(new URL('../src/app.ts', import.meta.url)), {
  oxc,
  logLevel: 'error',
});
// Only build the metadata graph. No application bootstrap or database calls.
const root = module.createAppModule({
  DB: {},
  LIVE_ROOM: {},
  APP_ORIGIN: 'http://localhost:8790',
  BETTER_AUTH_SECRET: 'contract-generation-only-never-used-for-requests',
});
const document = createOpenApiDocument(root, {
  info: { title: 'Vela API starter', version: '1.0.0' },
});
// The document endpoint describes the document itself, not an application call.
delete document.paths['/openapi.json'];
const { source, warnings } = generateClientContract(document);
// CRUD supports projected/custom output. Its unbound responses stay unknown;
// the browser uses the shared live schema to validate rows before rendering.
for (const warning of warnings) console.warn(warning);
const output = new URL('../web/api.generated.ts', import.meta.url);
if (process.argv.includes('--check')) {
  if ((await readFile(output, 'utf8')) !== source)
    throw new Error('Run pnpm client:generate to update the HTTP contract');
} else {
  await writeFile(output, source);
}
