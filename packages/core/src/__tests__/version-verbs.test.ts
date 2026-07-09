import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MetadataRegistry } from '@velajs/vela';
import { buildCrudOpenApiPaths } from '../index';
import type { CrudConfig } from '../types';

// biome-ignore lint/suspicious/noExplicitAny: dynamically-loaded test deps
let MemoryAdapters: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamically-loaded test deps
let defineMeta: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamically-loaded test deps
let defineModel: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamically-loaded test deps
let z: any;
let ok = false;

beforeAll(async () => {
  try {
    const hc = await import('hono-crud');
    const mem = await import('@hono-crud/memory');
    const zod = await import('zod');
    MemoryAdapters = mem.MemoryAdapters;
    defineMeta = hc.defineMeta;
    defineModel = hc.defineModel;
    z = zod.z;
    ok = true;
  } catch {
    ok = false;
  }
});

beforeEach(() => MetadataRegistry.clear());

class DummyController {}
const CTX = { globalPrefix: '', controllerPrefix: '/documents' };

function documentMeta(versioning: unknown) {
  return defineMeta({
    model: defineModel({
      tableName: 'document',
      schema: z.object({ id: z.string(), title: z.string(), version: z.number().default(1) }),
      primaryKeys: ['id'],
      ...(versioning === undefined ? {} : { versioning }),
    }),
  });
}

const VERSION_PATHS = [
  '/documents/{id}/versions',
  '/documents/{id}/versions/compare',
  '/documents/{id}/versions/{version}',
  '/documents/{id}/versions/{version}/rollback',
];

describe('version verbs — gating', () => {
  it('does NOT surface version routes on a non-versioned model by default', () => {
    if (!ok) return;
    const config: CrudConfig = { meta: documentMeta(undefined), adapters: MemoryAdapters };
    // biome-ignore lint/suspicious/noExplicitAny: test controller
    const p = buildCrudOpenApiPaths(DummyController as any, config, CTX);
    for (const path of VERSION_PATHS) expect(p[path]).toBeUndefined();
    // ...but the normal verbs are still there.
    expect(p['/documents'].get).toBeDefined();
  });

  it('surfaces version routes by default when the model declares versioning', () => {
    if (!ok) return;
    const config: CrudConfig = {
      meta: documentMeta({ field: 'version' }),
      adapters: MemoryAdapters,
    };
    // biome-ignore lint/suspicious/noExplicitAny: test controller
    const p = buildCrudOpenApiPaths(DummyController as any, config, CTX);
    expect(p['/documents/{id}/versions'].get).toBeDefined();
    expect(p['/documents/{id}/versions/compare'].get).toBeDefined();
    expect(p['/documents/{id}/versions/{version}'].get).toBeDefined();
    expect(p['/documents/{id}/versions/{version}/rollback'].post).toBeDefined();
  });

  it('treats versioning: true the same as a config object', () => {
    if (!ok) return;
    const config: CrudConfig = { meta: documentMeta(true), adapters: MemoryAdapters };
    // biome-ignore lint/suspicious/noExplicitAny: test controller
    const p = buildCrudOpenApiPaths(DummyController as any, config, CTX);
    expect(p['/documents/{id}/versions'].get).toBeDefined();
  });

  it('fails fast with an actionable error when a version verb is requested without model versioning', () => {
    if (!ok) return;
    const config: CrudConfig = {
      meta: documentMeta(undefined),
      adapters: MemoryAdapters,
      only: ['read', 'versionHistory'],
    };
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: test controller
      buildCrudOpenApiPaths(DummyController as any, config, CTX),
    ).toThrow(/version verb.*does not.*declare `versioning`/s);
  });

  it('an explicit `only` version verb works once the model declares versioning', () => {
    if (!ok) return;
    const config: CrudConfig = {
      meta: documentMeta(true),
      adapters: MemoryAdapters,
      only: ['read', 'versionHistory'],
    };
    // biome-ignore lint/suspicious/noExplicitAny: test controller
    const p = buildCrudOpenApiPaths(DummyController as any, config, CTX);
    expect(p['/documents/{id}/versions'].get).toBeDefined();
  });

  it('`except` can drop a version verb on a versioned model', () => {
    if (!ok) return;
    const config: CrudConfig = {
      meta: documentMeta(true),
      adapters: MemoryAdapters,
      except: ['versionRollback'],
    };
    // biome-ignore lint/suspicious/noExplicitAny: test controller
    const p = buildCrudOpenApiPaths(DummyController as any, config, CTX);
    expect(p['/documents/{id}/versions'].get).toBeDefined();
    expect(p['/documents/{id}/versions/{version}/rollback']).toBeUndefined();
  });
});

describe('version verbs — derived operationIds', () => {
  it('derives friendly {verb}{Noun}Version(s) operationIds + summaries', () => {
    if (!ok) return;
    const config: CrudConfig = { meta: documentMeta(true), adapters: MemoryAdapters };
    // biome-ignore lint/suspicious/noExplicitAny: test controller
    const p = buildCrudOpenApiPaths(DummyController as any, config, CTX);

    expect(p['/documents/{id}/versions'].get.operationId).toBe('listDocumentVersions');
    expect(p['/documents/{id}/versions/{version}'].get.operationId).toBe('getDocumentVersion');
    expect(p['/documents/{id}/versions/compare'].get.operationId).toBe('compareDocumentVersions');
    expect(p['/documents/{id}/versions/{version}/rollback'].post.operationId).toBe(
      'rollbackDocumentVersion',
    );

    expect(p['/documents/{id}/versions'].get.summary).toBe('List document versions');
    expect(p['/documents/{id}/versions/{version}'].get.summary).toBe('Get document version');
  });
});
