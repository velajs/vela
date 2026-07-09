/**
 * Memory adapter leg: in-process store, reset via `clearMemoryStorage()`.
 *
 * Capabilities:
 * - uniqueConstraints: false — the store has no constraint surface and the
 *   framework has no model-level unique declaration; the unique-conflict
 *   cell is skipped loudly (deferred — not ported).
 * - timestampKind: epoch-ms — library-managed (`Model.timestamps: true`).
 *
 * Lifecycle: the controller + Vela app are built ONCE per suite (in `setup`),
 * exactly as the engine's own HTTP tests do; DATA is reset between tests via
 * `clearMemoryStorage()` (mirrors hono-crud's memory leg, which wipes the
 * module-level store rather than re-mounting the app).
 */
import { Controller, Module, VelaFactory } from '@velajs/vela';
import { Crud } from '@velajs/crud';
import { clearMemoryStorage, memoryAdapter } from '@velajs/crud-memory';
import type { AdapterContext, AdapterDescriptor } from '../contract';
import {
  CONFORMANCE_FILTER_CONFIG,
  CONFORMANCE_SORT_FIELDS,
  CONFORMANCE_TABLE,
  conformanceModel,
} from '../model';

async function setup(): Promise<AdapterContext> {
  clearMemoryStorage();

  const adapter = memoryAdapter({
    tableName: CONFORMANCE_TABLE,
    primaryKey: 'id',
    softDeleteField: 'deletedAt',
  });

  @Controller('/items')
  @Crud({
    model: conformanceModel,
    adapter,
    filterConfig: CONFORMANCE_FILTER_CONFIG,
    sortFields: CONFORMANCE_SORT_FIELDS,
  })
  class ItemsController {}

  @Module({ controllers: [ItemsController] })
  class AppModule {}

  const app = await VelaFactory.create(AppModule);
  const hono = app.getHonoApp();

  return {
    app: { request: (path, init) => hono.request(path, init) },
    reset: () => {
      clearMemoryStorage();
    },
  };
}

export const memoryConformance: AdapterDescriptor = {
  name: 'memory',
  capabilities: {
    uniqueConstraints: false,
    timestampKind: 'epoch-ms',
  },
  setup,
};
