import { describe, it, expect, beforeEach } from 'vitest';
import { Controller, Get, Module, Injectable, MetadataRegistry } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import { VectorizeModule } from '../modules/vectorize.module';
import { VectorizeService } from '../services/vectorize.service';
beforeEach(() => {
  MetadataRegistry.clear();
});

function createMockVectorize() {
  const vectors = new Map<
    string,
    { id: string; values: number[]; metadata?: Record<string, unknown> }
  >();
  return {
    query: async (vector: number[], options?: Record<string, unknown>) => ({
      matches: [{ id: 'vec-1', score: 0.95, values: vector }],
      count: 1,
      ...options,
    }),
    insert: async (
      vecs: { id: string; values: number[]; metadata?: Record<string, unknown> }[],
    ) => {
      for (const v of vecs) vectors.set(v.id, v);
      return { mutationId: 'mut-1', count: vecs.length };
    },
    upsert: async (
      vecs: { id: string; values: number[]; metadata?: Record<string, unknown> }[],
    ) => {
      for (const v of vecs) vectors.set(v.id, v);
      return { mutationId: 'mut-2', count: vecs.length };
    },
    getByIds: async (ids: string[]) => ids.map((id) => vectors.get(id) ?? null).filter(Boolean),
    deleteByIds: async (ids: string[]) => {
      for (const id of ids) vectors.delete(id);
      return { mutationId: 'mut-3', count: ids.length };
    },
    describe: async () => ({
      dimensions: 384,
      vectorCount: vectors.size,
      processedUpToMutation: 'mut-0',
    }),
    _vectors: vectors,
  };
}

describe('VectorizeModule', () => {
  it('should inject VectorizeService with working query', async () => {
    const mockVectorize = createMockVectorize();

    @Controller('/search')
    class SearchController {
      constructor(private vectorize: VectorizeService) {}

      @Get('/query')
      async query() {
        const result = await this.vectorize.index.query([0.1, 0.2, 0.3], { topK: 10 });
        return result;
      }
    }

    @Module({
      imports: [VectorizeModule.forRoot({ binding: 'EMBEDDINGS' })],
      controllers: [SearchController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/search/query', undefined, { EMBEDDINGS: mockVectorize });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { matches: unknown[]; count: number; topK: number };
    expect(data.count).toBe(1);
    expect(data.topK).toBe(10);
  });

  it('should support insert and getByIds', async () => {
    const mockVectorize = createMockVectorize();

    @Controller('/vectors')
    class VectorController {
      constructor(private vectorize: VectorizeService) {}

      @Get('/insert')
      async insert() {
        await this.vectorize.index.insert([
          { id: 'v1', values: [1, 2, 3] },
          { id: 'v2', values: [4, 5, 6] },
        ]);
        const results = await this.vectorize.index.getByIds(['v1', 'v2']);
        return { results };
      }
    }

    @Module({
      imports: [VectorizeModule.forRoot({ binding: 'VECS' })],
      controllers: [VectorController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/vectors/insert', undefined, { VECS: mockVectorize });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { results: unknown[] };
    expect(data.results).toHaveLength(2);
  });

  it('should support describe', async () => {
    const mockVectorize = createMockVectorize();

    @Controller('/meta')
    class MetaController {
      constructor(private vectorize: VectorizeService) {}

      @Get()
      async describe() {
        return this.vectorize.index.describe();
      }
    }

    @Module({
      imports: [VectorizeModule.forRoot({ binding: 'IDX' })],
      controllers: [MetaController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/meta', undefined, { IDX: mockVectorize });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { dimensions: number };
    expect(data.dimensions).toBe(384);
  });

  it('should expose raw index via .index getter', async () => {
    const mockVectorize = createMockVectorize();

    @Controller('/raw')
    class RawController {
      constructor(private vectorize: VectorizeService) {}

      @Get()
      async test() {
        const idx = this.vectorize.index;
        const info = await idx.describe();
        return info;
      }
    }

    @Module({
      imports: [VectorizeModule.forRoot({ binding: 'RAW_VEC' })],
      controllers: [RawController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/raw', undefined, { RAW_VEC: mockVectorize });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { dimensions: number };
    expect(data.dimensions).toBe(384);
  });

  it('should allow VectorizeService in nested providers', async () => {
    const mockVectorize = createMockVectorize();

    @Injectable()
    class SemanticSearch {
      constructor(private vectorize: VectorizeService) {}
      async search(vector: number[]) {
        return this.vectorize.index.query(vector, { topK: 5 });
      }
    }

    @Controller('/semantic')
    class SemanticController {
      constructor(private search: SemanticSearch) {}

      @Get('/test')
      async test() {
        return this.search.search([0.1, 0.2]);
      }
    }

    @Module({
      imports: [VectorizeModule.forRoot({ binding: 'SEARCH' })],
      providers: [SemanticSearch],
      controllers: [SemanticController],
    })
    class AppModule {}

    const app = await createCloudflareApp(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/semantic/test', undefined, { SEARCH: mockVectorize });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { count: number };
    expect(data.count).toBe(1);
  });
});
