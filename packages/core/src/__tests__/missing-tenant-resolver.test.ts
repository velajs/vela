import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { MetadataRegistry } from '@velajs/vela';
import {
  CrudModule,
  MissingTenantResolverError,
  buildCrudRoutes,
  defineCrudResource,
} from '../index';
import * as PublicSurface from '../index';
import type { CrudConfig } from '../index';

let MemoryAdapters: unknown;
let defineMeta: ((opts: { model: unknown }) => unknown) | undefined;
let defineModel: ((opts: unknown) => unknown) | undefined;
let z: typeof import('zod') | undefined;
let clearStorage: (() => void) | undefined;
let honoCrudAvailable = false;

beforeAll(async () => {
  try {
    const honoCrud = { ...(await import('hono-crud')), ...(await import('@hono-crud/memory')), ...(await import('hono-crud/auth')), ...(await import('hono-crud/events')) };
    const memory = await import('@hono-crud/memory');
    const zod = await import('zod');
    MemoryAdapters = honoCrud.MemoryAdapters;
    defineMeta = honoCrud.defineMeta as typeof defineMeta;
    defineModel = honoCrud.defineModel as typeof defineModel;
    clearStorage = memory.clearStorage as () => void;
    z = zod;
    honoCrudAvailable = true;
  } catch {
    honoCrudAvailable = false;
  }
});

beforeEach(() => {
  MetadataRegistry.clear();
  if (honoCrudAvailable && clearStorage) clearStorage();
});

const builderCtx = () => ({
  globalPrefix: '',
  globalGuards: [],
  joinPaths: (...p: string[]) => p.filter(Boolean).join(''),
});

function tenantScopedMeta(): unknown {
  const schema = z!.object({ id: z!.string(), tenantId: z!.string(), name: z!.string() });
  const model = defineModel!({
    tableName: 'tenant_widgets',
    schema,
    primaryKeys: ['id'],
    multiTenant: true,
  });
  return defineMeta!({ model });
}

function plainMeta(): unknown {
  const schema = z!.object({ id: z!.string(), name: z!.string() });
  const model = defineModel!({
    tableName: 'plain_widgets',
    schema,
    primaryKeys: ['id'],
  });
  return defineMeta!({ model });
}

function objectMultiTenantMeta(): unknown {
  const schema = z!.object({ id: z!.string(), organizationId: z!.string(), name: z!.string() });
  const model = defineModel!({
    tableName: 'org_widgets',
    schema,
    primaryKeys: ['id'],
    multiTenant: {
      field: 'organizationId',
      source: 'header',
      headerName: 'X-Organization-ID',
    },
  });
  return defineMeta!({ model });
}

describe('MissingTenantResolverError (1.1.0)', () => {
  it('throws synchronously when forResource mounts a tenant-scoped Model without affirmation', () => {
    if (!honoCrudAvailable) return;
    expect(() =>
      CrudModule.forResource('/tenant-widgets', {
        meta: tenantScopedMeta() as never,
        adapters: MemoryAdapters as never,
      }),
    ).toThrowError(MissingTenantResolverError);
  });

  it('error message includes the table name and mount path', () => {
    if (!honoCrudAvailable) return;
    let captured: unknown;
    try {
      CrudModule.forResource('/tenant-widgets', {
        meta: tenantScopedMeta() as never,
        adapters: MemoryAdapters as never,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(MissingTenantResolverError);
    const err = captured as MissingTenantResolverError;
    expect(err.tableName).toBe('tenant_widgets');
    expect(err.mountPath).toBe('/tenant-widgets');
    expect(err.message).toContain('tenant_widgets');
    expect(err.message).toContain('/tenant-widgets');
    // The message must point readers at the canonical wiring fix.
    expect(err.message).toContain('multiTenant()');
    expect(err.message).toContain('tenantResolverMounted: true');
    // The message must reference the [0.6.0] CHANGELOG anchor.
    expect(err.message).toContain('[0.6.0]');
  });

  it('also throws when the multiTenant field is an object (MultiTenantConfig)', () => {
    if (!honoCrudAvailable) return;
    expect(() =>
      CrudModule.forResource('/org-widgets', {
        meta: objectMultiTenantMeta() as never,
        adapters: MemoryAdapters as never,
      }),
    ).toThrowError(MissingTenantResolverError);
  });

  it('does NOT throw when tenantResolverMounted: true is set (escape hatch)', () => {
    if (!honoCrudAvailable) return;
    expect(() =>
      CrudModule.forResource('/tenant-widgets', {
        meta: tenantScopedMeta() as never,
        adapters: MemoryAdapters as never,
        tenantResolverMounted: true,
      }),
    ).not.toThrow();
  });

  it('does NOT throw for a non-tenant-scoped Model without the flag (regression guard)', () => {
    if (!honoCrudAvailable) return;
    expect(() =>
      CrudModule.forResource('/plain-widgets', {
        meta: plainMeta() as never,
        adapters: MemoryAdapters as never,
      }),
    ).not.toThrow();
  });

  it('defineCrudResource also fails fast for tenant-scoped models', () => {
    if (!honoCrudAvailable) return;
    expect(() =>
      defineCrudResource({
        path: '/tenant-widgets',
        meta: tenantScopedMeta() as never,
        adapters: MemoryAdapters as never,
      }),
    ).toThrowError(MissingTenantResolverError);

    expect(() =>
      defineCrudResource({
        path: '/tenant-widgets',
        meta: tenantScopedMeta() as never,
        adapters: MemoryAdapters as never,
        tenantResolverMounted: true,
      }),
    ).not.toThrow();
  });

  it('buildCrudRoutes also fails fast for the @Crud-decorator path', async () => {
    if (!honoCrudAvailable) return;
    const config: CrudConfig = {
      meta: tenantScopedMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['create'],
    };
    class Stub {}
    await expect(
      buildCrudRoutes(new Hono(), Stub as never, '/widgets', config, builderCtx()),
    ).rejects.toBeInstanceOf(MissingTenantResolverError);
  });

  it('buildCrudRoutes accepts the affirmation', async () => {
    if (!honoCrudAvailable) return;
    const config: CrudConfig = {
      meta: tenantScopedMeta() as never,
      adapters: MemoryAdapters as never,
      only: ['create'],
      tenantResolverMounted: true,
    };
    class Stub {}
    await expect(
      buildCrudRoutes(new Hono(), Stub as never, '/widgets', config, builderCtx()),
    ).resolves.toBeUndefined();
  });

  it('MissingTenantResolverError is exported from the package public surface', () => {
    expect(typeof PublicSurface.MissingTenantResolverError).toBe('function');
    const instance = new PublicSurface.MissingTenantResolverError({
      mountPath: '/x',
      tableName: 't',
    });
    expect(instance).toBeInstanceOf(Error);
    expect(instance.name).toBe('MissingTenantResolverError');
  });
});
