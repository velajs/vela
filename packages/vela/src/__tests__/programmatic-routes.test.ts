import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  VelaFactory,
  Controller,
  Get,
  Post,
  Body,
  Module,
  Injectable,
  MetadataRegistry,
  ParamType,
  defineDto,
  ValidationPipe,
  createOpenApiDocument,
  createParamDecorator,
  getRequestContainer,
  REQUEST_CONTEXT,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

// =============================================================================
// Programmatic routes with explicit param `metatype`
//
// Methods synthesized at runtime (the native @Crud() path) have no
// `design:paramtypes`, so ValidationPipe and the OpenAPI walk must read the
// metatype carried on the parameter metadata itself.
// =============================================================================

/** Stamps a synthesized handler + route + params the way `@Crud()` does. */
function synthesizeRoute(
  controller: abstract new (...args: never[]) => unknown,
  handlerName: string,
  method: 'GET' | 'POST',
  path: string,
  handler: (...args: unknown[]) => unknown,
  params: Array<{ index: number; type: string; name?: string; metatype?: unknown }>,
  name?: string,
): void {
  Object.defineProperty(controller.prototype, handlerName, {
    value: handler,
    writable: true,
    configurable: true,
  });
  const decorate = method === 'GET' ? Get : Post;
  decorate(path, name !== undefined ? { name } : undefined)(
    controller.prototype as object,
    handlerName,
    Object.getOwnPropertyDescriptor(controller.prototype, handlerName)!,
  );
  for (const param of params) {
    MetadataRegistry.addParameter(controller as never, handlerName, param);
  }
}

describe('explicit param metatype on programmatic routes', () => {
  it('ValidationPipe validates a synthesized @Body param via explicit metatype', async () => {
    const CreateItemSchema = z.object({ name: z.string(), qty: z.number().int().positive() });
    const CreateItemDto = defineDto(CreateItemSchema, { name: 'CreateItemDto' });
    type CreateItemDto = ReturnType<typeof CreateItemDto.parse>;

    @Controller('/items')
    class ItemsController {}

    synthesizeRoute(
      ItemsController,
      'crud$create',
      'POST',
      '',
      function (body: unknown) {
        return { created: body };
      },
      [{ index: 0, type: ParamType.BODY, metatype: CreateItemDto }],
      'items.create',
    );

    @Module({ controllers: [ItemsController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalPipes(new ValidationPipe());
    const hono = app.getHonoApp();

    const valid = await hono.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'anchor', qty: 3 }),
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ created: { name: 'anchor', qty: 3 } });

    const invalid = await hono.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'anchor', qty: -1 }),
    });
    expect(invalid.status).toBe(400);
    const errorBody = (await invalid.json()) as { error?: { code: string; message: string } };
    expect(errorBody.error).toMatchObject({ code: 'bad_request', message: 'Validation failed' });
  });

  it('ValidationPipe validates a synthesized @Query param via explicit metatype', async () => {
    const ListQuerySchema = z.object({
      page: z.coerce.number().int().min(1).default(1),
    });
    const ItemListQuery = defineDto(ListQuerySchema, { name: 'ItemListQuery' });
    type ItemListQuery = ReturnType<typeof ItemListQuery.parse>;

    @Controller('/items')
    class ItemsController {}

    synthesizeRoute(
      ItemsController,
      'crud$list',
      'GET',
      '',
      function (query: unknown) {
        return { query };
      },
      [{ index: 0, type: ParamType.QUERY, metatype: ItemListQuery }],
    );

    @Module({ controllers: [ItemsController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalPipes(new ValidationPipe());
    const hono = app.getHonoApp();

    const ok = await hono.request('/items?page=2');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ query: { page: 2 } });

    const bad = await hono.request('/items?page=zero');
    expect(bad.status).toBe(400);
  });

  it('OpenAPI surfaces the explicit metatype as a named component schema', () => {
    const CreateItemSchema = z.object({ name: z.string() });
    const CreateItemDto = defineDto(CreateItemSchema, { name: 'CreateItemDto' });
    type CreateItemDto = ReturnType<typeof CreateItemDto.parse>;

    @Controller('/items')
    class ItemsController {}

    synthesizeRoute(
      ItemsController,
      'crud$create',
      'POST',
      '',
      function (body: unknown) {
        return body;
      },
      [{ index: 0, type: ParamType.BODY, metatype: CreateItemDto }],
    );

    @Module({ controllers: [ItemsController] })
    class AppModule {}

    const doc = createOpenApiDocument(AppModule);

    const post = doc.paths['/items']?.post;
    expect(post).toBeDefined();
    expect(JSON.stringify(post)).toContain('#/components/schemas/CreateItemDto');
    expect(doc.components?.schemas?.CreateItemDto).toBeDefined();
  });

  it('falls back to design:paramtypes when no explicit metatype is present (regression)', async () => {
    const schema = z.object({ email: z.string().email() });
    const SignupDto = defineDto(schema, { name: 'SignupDto' });
    type SignupDto = ReturnType<typeof SignupDto.parse>;

    @Injectable()
    class Noop {}

    @Controller('/signup')
    class SignupController {
      @Post()
      create(@Body(new ValidationPipe(SignupDto)) dto: SignupDto) {
        return dto;
      }
    }

    @Module({ providers: [Noop], controllers: [SignupController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalPipes(new ValidationPipe());

    const bad = await app.getHonoApp().request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nope' }),
    });
    expect(bad.status).toBe(400);
  });
});

// =============================================================================
// getRequestContainer — the promoted public seam
// =============================================================================

describe('getRequestContainer', () => {
  it('yields the request child (REQUEST_CONTEXT resolvable) inside a request', async () => {
    const CurrentContainer = createParamDecorator((_data, ctx) =>
      getRequestContainer(ctx.getContext()),
    );

    @Controller('/probe')
    class ProbeController {
      @Get()
      probe(@CurrentContainer() container: { resolve(token: unknown): unknown }) {
        // REQUEST_CONTEXT's root factory throws; only the request child has it
        // seeded — resolving it proves we received the child, not the root.
        try {
          const rc = container.resolve(REQUEST_CONTEXT) as { request?: unknown } | undefined;
          return { seeded: rc !== undefined && rc !== null };
        } catch (e) {
          return { seeded: false, error: (e as Error).message };
        }
      }
    }

    @Module({ controllers: [ProbeController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/probe');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seeded: true });
  });

  it('throws outside a Vela-managed request', () => {
    const bareContext = { get: () => undefined } as unknown as Parameters<
      typeof getRequestContainer
    >[0];
    expect(() => getRequestContainer(bareContext)).toThrow(/Vela-managed request/);
  });
});
