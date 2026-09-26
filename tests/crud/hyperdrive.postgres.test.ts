import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const connectionString = process.env.VELA_POSTGRES_URL;
describe.skipIf(!connectionString)(
  'Hyperdrive binding in native Workers with local PostgreSQL',
  () => {
    let runtime: Miniflare, directory: string;
    const admin = new Pool({ connectionString });
    let createdTable = false;
    const headers = { Authorization: 'Bearer synthetic-test', 'Content-Type': 'application/json' };
    beforeAll(async () => {
      // This suite requires a disposable database. Existing tables are never overwritten.
      await admin.query(await readFile('apps/hyperdrive-crud/migrations/0001_items.sql', 'utf8'));
      createdTable = true;
      execFileSync('pnpm', ['--filter', 'vela-hyperdrive-crud', 'build'], { stdio: 'pipe' });
      directory = 'apps/hyperdrive-crud/dist/vela_hyperdrive_crud';
      const modules: Record<string, { type: 'esm'; contents: string }> = {};
      for (const file of await readdir(directory))
        if (file.endsWith('.js'))
          modules[file] = { type: 'esm', contents: await readFile(join(directory, file), 'utf8') };
      runtime = new Miniflare({
        workers: [
          {
            config: {
              name: 'hyperdrive-lifecycle',
              type: 'worker',
              compatibilityDate: '2026-09-20',
              compatibilityFlags: ['nodejs_compat'],
              manifest: { mainModule: 'index.js', modules },
              env: {
                ACCESS_TOKEN: { type: 'text', value: 'synthetic-test' },
                HYPERDRIVE: {
                  type: 'hyperdrive',
                  id: 'synthetic',
                  dev: { connectionString: connectionString! },
                },
              },
            },
          },
        ],
      });
    }, 30_000);
    afterAll(async () => {
      try {
        await runtime?.dispose();
      } finally {
        try {
          if (createdTable) await admin.query('DROP TABLE lifecycle_items');
        } finally {
          await admin.end();
        }
      }
    });
    it('runs concurrent and subsequent CRUD requests through real pg sockets', async () => {
      expect((await runtime.dispatchFetch('https://test/items')).status).toBe(401);
      const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
      for (const response of await Promise.all(
        ids.map((id) =>
          runtime.dispatchFetch('https://test/items', {
            method: 'POST',
            headers,
            body: JSON.stringify({ id, title: 'created' }),
          }),
        ),
      ))
        expect(response.status, await response.text()).toBe(201);
      for (const id of ids) {
        const update = await runtime.dispatchFetch(`https://test/items/${id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ title: 'updated' }),
        });
        expect(update.status, await update.text()).toBe(200);
        expect(
          await (await runtime.dispatchFetch(`https://test/items/${id}`, { headers })).json(),
        ).toMatchObject({ result: { id, title: 'updated' } });
        const remove = await runtime.dispatchFetch(`https://test/items/${id}`, {
          method: 'DELETE',
          headers,
        });
        expect(remove.status, await remove.text()).toBe(200);
      }
      expect((await admin.query('SELECT * FROM lifecycle_items')).rows).toEqual([]);
    }, 30_000);
  },
);
