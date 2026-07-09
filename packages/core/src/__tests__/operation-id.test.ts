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
const CTX = { globalPrefix: '', controllerPrefix: '/comments' };

function commentMeta() {
  return defineMeta({
    model: defineModel({
      tableName: 'comment',
      schema: z.object({ id: z.string(), body: z.string() }),
      primaryKeys: ['id'],
    }),
  });
}

describe('derived OpenAPI operationIds', () => {
  it('derives friendly per-verb operationIds from the model tableName', () => {
    if (!ok) return;
    const config: CrudConfig = {
      meta: commentMeta(),
      adapters: MemoryAdapters,
      only: [
        'create',
        'list',
        'read',
        'update',
        'delete',
        'restore',
        'batchDelete',
        'batchUpdate',
        'search',
        'aggregate',
      ],
    };
    // biome-ignore lint/suspicious/noExplicitAny: test controller
    const p = buildCrudOpenApiPaths(DummyController as any, config, CTX);

    expect(p['/comments'].post.operationId).toBe('createComment');
    expect(p['/comments'].get.operationId).toBe('listComments');
    expect(p['/comments/{id}'].get.operationId).toBe('getComment'); // read -> get
    expect(p['/comments/{id}'].patch.operationId).toBe('updateComment');
    expect(p['/comments/{id}'].delete.operationId).toBe('deleteComment');
    expect(p['/comments/{id}/restore'].post.operationId).toBe('restoreComment');
    expect(p['/comments/batch'].delete.operationId).toBe('bulkDeleteComments'); // batch -> bulk
    expect(p['/comments/batch'].patch.operationId).toBe('bulkUpdateComments');
    expect(p['/comments/search'].get.operationId).toBe('searchComments');
    expect(p['/comments/aggregate'].get.operationId).toBe('aggregateComments');
    // human-readable summaries too
    expect(p['/comments'].get.summary).toBe('List comments');
    expect(p['/comments/{id}'].get.summary).toBe('Get a comment');
  });

  it('lets a per-endpoint openapi.operationId win over the derived one', () => {
    if (!ok) return;
    const config: CrudConfig = {
      meta: commentMeta(),
      adapters: MemoryAdapters,
      only: ['list'],
      // biome-ignore lint/suspicious/noExplicitAny: openapi override
      endpoints: { list: { openapi: { operationId: 'myComments' } } as any },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test controller
    const p = buildCrudOpenApiPaths(DummyController as any, config, CTX);
    expect(p['/comments'].get.operationId).toBe('myComments');
  });

  it('honors an explicit name/namePlural for irregular plurals', () => {
    if (!ok) return;
    const config: CrudConfig = {
      meta: defineMeta({
        model: defineModel({
          tableName: 'person',
          schema: z.object({ id: z.string() }),
          primaryKeys: ['id'],
        }),
      }),
      adapters: MemoryAdapters,
      name: 'person',
      namePlural: 'people',
      only: ['list', 'create'],
    };
    // biome-ignore lint/suspicious/noExplicitAny: test controller
    const p = buildCrudOpenApiPaths(DummyController as any, config, {
      globalPrefix: '',
      controllerPrefix: '/people',
    });
    expect(p['/people'].get.operationId).toBe('listPeople');
    expect(p['/people'].post.operationId).toBe('createPerson');
  });
});
