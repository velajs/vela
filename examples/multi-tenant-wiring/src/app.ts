/**
 * Canonical wiring for a tenant-scoped @velajs/crud resource.
 *
 * Demonstrates the contract introduced in @velajs/crud@1.1.0:
 *
 *   1. The Model declares tenant scope via `multiTenant: true`.
 *   2. The parent Hono app mounts a tenant resolver upstream of the
 *      resource — here, hono-crud's `multiTenant()` middleware, which
 *      reads `X-Tenant-ID` by default and calls `c.set('tenantId', ...)`
 *      so HookContext and CrudEventPayload receive the resolved tenant id.
 *   3. The bridge config affirms the wiring with `tenantResolverMounted: true`.
 *
 * Without step 3, `CrudModule.forResource(...)` throws
 * `MissingTenantResolverError` synchronously at module-load time. Without
 * step 2, hono-crud surfaces the missing tenant id as a 400 at request
 * time. Together, these defend against the silent `tenantId: undefined`
 * data-loss bug class for hooks, audit logs, events, and CDC consumers.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { Module, VelaFactory } from '@velajs/vela';
import type { VelaApplication } from '@velajs/vela';
import { CrudModule } from '@velajs/crud';
import {
  MemoryAdapters,
  defineMeta,
  defineModel,
  multiTenant,
} from 'hono-crud';
import type { AdapterBundle, MetaInput } from 'hono-crud';

const TaskSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  title: z.string(),
  done: z.boolean().default(false),
});

const TaskModel = defineModel({
  tableName: 'tenant_tasks',
  schema: TaskSchema,
  primaryKeys: ['id'],
  // Declares tenant scope. With this set, @velajs/crud requires
  // `tenantResolverMounted: true` on the bridge config.
  multiTenant: true,
});

const taskMeta = defineMeta({ model: TaskModel }) as MetaInput;
const adapters = MemoryAdapters as AdapterBundle;

export interface MultiTenantFixture {
  /** Vela application that owns the CRUD resource. */
  app: VelaApplication;
  /** Outer Hono app: mounts `multiTenant()` upstream of the Vela app. */
  hono: Hono;
}

export async function createMultiTenantApp(): Promise<MultiTenantFixture> {
  // The bridge's affirmation contract: this resource is tenant-scoped, and
  // the caller affirms a tenant resolver runs upstream. Removing this flag
  // throws MissingTenantResolverError at module-load time.
  const taskResource = CrudModule.forResource('/tasks', {
    meta: taskMeta,
    adapters,
    only: ['create', 'list', 'read'],
    tenantResolverMounted: true,
  });

  @Module({ imports: [taskResource] })
  class MultiTenantApp {}

  const app = await VelaFactory.create(MultiTenantApp);

  // Outer Hono app: mounts the tenant resolver, then routes everything
  // into the Vela-owned Hono app. Hono middleware applies to routes
  // matched after the `use(...)` call, so `multiTenant()` runs before the
  // CRUD handlers see the request.
  const outer = new Hono();
  outer.use('/*', multiTenant());
  outer.route('/', app.getHonoApp());

  return { app, hono: outer };
}
