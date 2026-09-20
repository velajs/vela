/**
 * Canonical wiring for a tenant-scoped @velajs/crud resource.
 *
 * 1. The model declares `multiTenant: true` — the engine scopes every lookup,
 *    stamps `tenantId` on create, and filters every list by the resolved
 *    tenant.
 * 2. `multiTenant()` (the resolver middleware) is mounted UPSTREAM of the
 *    Vela app on an outer Hono — Vela builds its routes at create() time.
 * 3. The resource affirms `tenantResolverMounted: true` — without it,
 *    decoration throws `MissingTenantResolverError` (a missing resolver
 *    silently loses tenant isolation: a data-loss class, so it fails fast).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { Controller, Module, VelaFactory } from '@velajs/vela';
import { Crud, CrudException, defineModel, multiTenant } from '@velajs/crud';
import { clearMemoryStorage, memoryAdapter } from '@velajs/crud-memory';

export const Note = defineModel({
  name: 'note',
  tableName: 'notes',
  schema: z.object({
    id: z.uuid(),
    text: z.string().min(1),
    tenantId: z.string().nullable().optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
    deletedAt: z.number().nullable().optional(),
  }),
  softDelete: true,
  multiTenant: true,
});

@Controller('/notes')
@Crud({
  model: Note,
  adapter: memoryAdapter({ tableName: 'notes', softDeleteField: 'deletedAt' }),
  tenantResolverMounted: true,
})
export class NotesController {}

@Module({ controllers: [NotesController] })
export class AppModule {}

export async function createApp(): Promise<Hono> {
  clearMemoryStorage();
  const app = await VelaFactory.create(AppModule);

  const outer = new Hono();
  outer.onError((err, c) => {
    if (err instanceof CrudException) {
      return c.json(err.getResponse() as Record<string, unknown>, err.getStatus() as never);
    }
    throw err;
  });
  outer.use(
    '*',
    multiTenant({
      // Replace this illustrative allow-list with your authenticated user's
      // tenant-membership lookup. A header alone is never authorization.
      validate: (tenantId) => tenantId === 'tenant-a' || tenantId === 'tenant-b',
    }),
  ); // resolves X-Tenant-ID (400 TENANT_REQUIRED without it)
  outer.route('/', app.getHonoApp());
  return outer;
}
