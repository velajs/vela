import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Controller,
  Get,
  Post,
  Module,
  MetadataRegistry,
  METADATA_KEYS,
  createOpenApiDocument,
  defineMetadata,
  ApiTags,
} from '../index.js';
import { registerCrudBridge, _resetCrudBridge } from '../http/crud-bridge.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

afterEach(() => {
  _resetCrudBridge();
});

describe('createOpenApiDocument — top-level tags aggregation', () => {
  it('collects distinct controller-level @ApiTags into doc.tags in first-seen order', () => {
    @Controller('/products')
    @ApiTags('Products')
    class ProductsController {
      @Get()
      list() {
        return [];
      }
    }

    @Controller('/meta')
    @ApiTags('Meta')
    class MetaController {
      @Get()
      info() {
        return {};
      }
    }

    @Module({ controllers: [ProductsController, MetaController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);

    expect(doc.tags).toEqual([{ name: 'Products' }, { name: 'Meta' }]);
  });

  it('collects handler-level @ApiTags into doc.tags', () => {
    @Controller('/users')
    @ApiTags('Users')
    class UsersController {
      @Get()
      @ApiTags('Listing')
      list() {
        return [];
      }
    }

    @Module({ controllers: [UsersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);

    const names = (doc.tags ?? []).map((t) => t.name);
    expect(names).toContain('Users');
    expect(names).toContain('Listing');
  });

  it('merges options.tags: declared descriptions are kept, tags with no ops are kept, declared come first', () => {
    @Controller('/products')
    @ApiTags('Products')
    class ProductsController {
      @Get()
      list() {
        return [];
      }
    }

    @Controller('/orders')
    @ApiTags('Orders')
    class OrdersController {
      @Get()
      list() {
        return [];
      }
    }

    @Module({ controllers: [ProductsController, OrdersController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule, {
      tags: [
        { name: 'Products', description: 'CRUD over products' },
        { name: 'Internal', description: 'x' },
      ],
    });

    expect(doc.tags).toEqual([
      { name: 'Products', description: 'CRUD over products' },
      { name: 'Internal', description: 'x' },
      { name: 'Orders' },
    ]);
  });

  it('collects bridge-contributed operation tags into doc.tags', () => {
    @Controller('/things')
    class ThingsController {
      @Get()
      @ApiTags('Things')
      list() {
        return [];
      }
    }
    defineMetadata(METADATA_KEYS.CRUD, { entity: 'Thing' }, ThingsController);

    @Module({ controllers: [ThingsController] })
    class AppModule {}

    registerCrudBridge({
      buildRoutes: async () => {},
      buildOpenApiPaths: () => ({
        '/things/{id}': {
          get: {
            summary: 'Read a thing',
            tags: ['CrudThings'],
            responses: { '200': { description: 'OK' } },
          },
        },
      }),
    });

    const doc = createOpenApiDocument(AppModule);

    const names = (doc.tags ?? []).map((t) => t.name);
    expect(names).toContain('Things');
    expect(names).toContain('CrudThings');
  });

  it('omits the tags key entirely when no operation is tagged and no options.tags (regression)', () => {
    @Controller('/plain')
    class PlainController {
      @Get()
      list() {
        return [];
      }

      @Post()
      create() {
        return {};
      }
    }

    @Module({ controllers: [PlainController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);

    expect(doc.tags).toBeUndefined();
    expect('tags' in doc).toBe(false);
  });
});
