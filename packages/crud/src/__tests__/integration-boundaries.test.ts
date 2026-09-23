import {
  Controller,
  MetadataRegistry,
  Module,
  ValidationPipe,
  VelaFactory,
  defineMetadata,
} from '@velajs/vela';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { MemoryAuditStore, type AuditStore } from '../audit/index';
import { Crud, getCrudConfig } from '../crud.decorator';
import { CrudModule } from '../crud.module';
import {
  CRUD_DEFAULT_AUDIT_STORE,
  CRUD_DEFAULT_VERSIONING_STORE,
  crudResourceToken,
} from '../crud.tokens';
import { ConfigurationException } from '../envelope/errors';
import { defineModel } from '../model/define-model';
import { Override } from '../override.decorator';
import { getOverrides } from '../stamp-routes';
import { MemoryVersioningStore, type VersioningStore } from '../versioning/index';
import { testAdapter } from './test-adapter';

const model = defineModel({
  name: 'boundaryItem',
  tableName: 'boundary_items',
  schema: z.object({ id: z.string(), name: z.string().min(1) }),
});

describe('CRUD integration boundaries', () => {
  it('keeps optional store token types and undefined values honest', async () => {
    const runtime = testAdapter(new Map()).runtime;
    @Module({ imports: [CrudModule.forRoot({ adapter: { runtime } })] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const auditStore = app.get(CRUD_DEFAULT_AUDIT_STORE);
    const versioningStore = app.get(CRUD_DEFAULT_VERSIONING_STORE);
    expectTypeOf(auditStore).toEqualTypeOf<AuditStore | undefined>();
    expectTypeOf(versioningStore).toEqualTypeOf<VersioningStore | undefined>();
    expect(auditStore).toBeUndefined();
    expect(versioningStore).toBeUndefined();
  });

  it('resolves configured stores through checked module providers', async () => {
    const auditStore = new MemoryAuditStore();
    const versioningStore = new MemoryVersioningStore();
    @Module({
      imports: [
        CrudModule.forRoot({ adapter: testAdapter(new Map()), auditStore, versioningStore }),
      ],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.get(CRUD_DEFAULT_AUDIT_STORE)).toBe(auditStore);
    expect(app.get(CRUD_DEFAULT_VERSIONING_STORE)).toBe(versioningStore);
  });

  it('documents generated bodies while the engine owns validation', () => {
    const adapter = testAdapter(new Map());
    @Controller('/boundary-items')
    @Crud({ model, adapter })
    class ItemsController {}

    expect(getCrudConfig(ItemsController)?.adapter).toBe(adapter.runtime);
    const params = MetadataRegistry.getParameters(ItemsController).get('crud$create');
    const metatype = params?.find((param) => param.type === 'body')?.metatype;
    expect(typeof metatype).toBe('object');
    expect(Object.isFrozen(metatype)).toBe(true);
    const pipe = new ValidationPipe();
    expect(pipe.transform({ name: 'Valid' }, { type: 'body', metatype })).toEqual({
      name: 'Valid',
    });
    const invalid = { name: '' };
    expect(pipe.transform(invalid, { type: 'body', metatype })).toBe(invalid);
    expect(metatype).toMatchObject({ validationOwner: 'handler' });
  });

  it('preserves symbol-named override methods', async () => {
    const list = Symbol('customList');
    @Controller('/symbol-items')
    @Crud({ model, adapter: testAdapter(new Map()), only: ['list'] })
    class ItemsController {
      @Override('list')
      [list]() {
        return { custom: true };
      }
    }
    @Module({ controllers: [ItemsController] })
    class AppModule {}

    expect(getOverrides(ItemsController).list).toBe(list);
    const app = await VelaFactory.create(AppModule);
    const response = await app.getHonoApp().request('/symbol-items');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ custom: true });
  });

  it.each([null, [], { list: 123 }, { unknownVerb: 'handler' }])(
    'rejects malformed override metadata: %j',
    (metadata) => {
      class ItemsController {}
      defineMetadata('velajs:crud:overrides', metadata, ItemsController);
      expect(() => getOverrides(ItemsController)).toThrow(ConfigurationException);
    },
  );

  it('reuses named resource token identities across module re-evaluation', async () => {
    const before = crudResourceToken('boundaryItem');
    vi.resetModules();
    const { crudResourceToken: reloaded } = await import('../crud.tokens');
    expect(reloaded('boundaryItem')).toBe(before);
    expect(reloaded('otherItem')).not.toBe(before);
  });
});
