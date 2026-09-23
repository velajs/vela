import { setCookie } from 'hono/cookie';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Body,
  Controller,
  Cookie,
  Endpoint,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Ip,
  MetadataRegistry,
  Module,
  Param,
  Post,
  Query,
  RawBody,
  Redirect,
  Req,
  REQUEST_CONTEXT,
  RequestContextKey,
  Res,
  UseGuards,
  UseInterceptors,
  VelaFactory,
  ValidationPipe,
  createLazyParamDecorator,
  createParamDecorator,
  defineEndpoint,
} from '../index';
import type {
  ArgumentMetadata,
  CanActivate,
  ExecutionContext,
  NestInterceptor,
  PipeTransform,
  VelaContext,
} from '../index';

beforeEach(() => MetadataRegistry.clear());

describe('schema-bound HTTP endpoints', () => {
  it('applies a transforming input parser once with a global ValidationPipe', async () => {
    let parses = 0;
    const wire = z.object({ json: z.object({ count: z.string().regex(/^\d+$/) }) });
    const input = {
      parse(value: unknown) {
        parses += 1;
        return { json: { count: Number(wire.parse(value).json.count) } };
      },
      toJSONSchema: () => wire.toJSONSchema(),
    };
    const definition = defineEndpoint({ input, output: z.number() });
    @Controller('/transform')
    class Transform {
      @Post()
      @Endpoint(definition)
      create(value: ReturnType<typeof input.parse>) {
        return value.json.count;
      }
    }
    @Module({ controllers: [Transform] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new ValidationPipe());
    const response = await app.getHonoApp().request('/transform', {
      method: 'POST',
      body: JSON.stringify({ count: '12' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toBe(12);
    expect(parses).toBe(1);
    await app.close();
  });

  it('retains explicit text responses in the shared contract', async () => {
    const definition = defineEndpoint({ input: z.object({}), output: z.string(), format: 'text' });
    @Controller('/text')
    class Text {
      @Get()
      @Endpoint(definition)
      read(_input: ReturnType<typeof definition.input.parse>) {
        return 'ready';
      }
    }
    @Module({ controllers: [Text] })
    class App {}
    const app = await VelaFactory.create(App);
    const response = await app.getHonoApp().request('/text');
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('ready');
    await app.close();
  });
  it('parses wire groups and preserves single/repeated array query parameters', async () => {
    const definition = defineEndpoint({
      input: z.object({
        param: z.object({ id: z.string() }),
        query: z.object({ tag: z.array(z.string()), limit: z.coerce.number().int().default(10) }),
        header: z.object({ 'x-example': z.string() }),
      }),
      output: z.object({
        id: z.string(),
        tags: z.array(z.string()),
        limit: z.number(),
        header: z.string(),
      }),
    });
    @Controller('/items')
    class Items {
      @Get('/:id')
      @Endpoint(definition)
      read(input: ReturnType<typeof definition.input.parse>) {
        return {
          id: input.param.id,
          tags: input.query.tag,
          limit: input.query.limit,
          header: input.header['x-example'],
        };
      }
    }
    @Module({ controllers: [Items] })
    class App {}
    const app = await VelaFactory.create(App);
    const response = await app
      .getHonoApp()
      .request('/items/a?tag=one', { headers: { 'x-example': 'yes' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'a', tags: ['one'], limit: 10, header: 'yes' });
    const repeated = await app
      .getHonoApp()
      .request('/items/b?tag=one&tag=two&limit=2', { headers: { 'x-example': 'yes' } });
    expect(await repeated.json()).toMatchObject({ tags: ['one', 'two'], limit: 2 });
    const duplicateScalar = await app
      .getHonoApp()
      .request('/items/a?tag=one&limit=1&limit=2', { headers: { 'x-example': 'yes' } });
    expect(duplicateScalar.status).toBe(400);
    await app.close();
  });

  it('guards run before malformed body parsing and endpoint input validation', async () => {
    const definition = defineEndpoint({
      input: z.object({ json: z.object({ name: z.string() }) }),
      output: z.string(),
    });
    @Injectable()
    class Deny implements CanActivate {
      canActivate() {
        return false;
      }
    }
    @Controller('/guarded')
    class Guarded {
      @Post()
      @UseGuards(Deny)
      @Endpoint(definition)
      create(input: ReturnType<typeof definition.input.parse>) {
        return input.json.name;
      }
    }
    @Module({ controllers: [Guarded], providers: [Deny] })
    class App {}
    const app = await VelaFactory.create(App);
    const response = await app.getHonoApp().request('/guarded', { method: 'POST', body: '{bad' });
    expect(response.status).toBe(403);
    await app.close();
  });

  it('rejects invalid input, parses valid bodies, and sends JSON strings at the declared status', async () => {
    const definition = defineEndpoint({
      input: z.object({ json: z.object({ name: z.string() }) }),
      output: z.string(),
      status: 201,
    });
    @Controller('/create')
    class Create {
      @Post()
      @Endpoint(definition)
      create(input: ReturnType<typeof definition.input.parse>) {
        return input.json.name;
      }
    }
    @Module({ controllers: [Create] })
    class App {}
    const app = await VelaFactory.create(App);
    for (const body of ['{bad', '{}', '{"name":42}']) {
      expect((await app.getHonoApp().request('/create', { method: 'POST', body })).status).toBe(
        400,
      );
    }
    const response = await app
      .getHonoApp()
      .request('/create', { method: 'POST', body: '{"name":"Ada"}' });
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toBe('Ada');
    await app.close();
  });

  it('validates interceptor output before returning it and preserves JSON null', async () => {
    const definition = defineEndpoint({
      input: z.object({}),
      output: z.object({ id: z.string() }),
    });
    const nullDefinition = defineEndpoint({ input: z.object({}), output: z.null() });
    @Injectable()
    class Corrupt implements NestInterceptor {
      async intercept() {
        return { id: 42 };
      }
    }
    @Controller('/output')
    class Output {
      @Get('/invalid')
      @UseInterceptors(Corrupt)
      @Endpoint(definition)
      read(_input: ReturnType<typeof definition.input.parse>) {
        return { id: 'ok' };
      }
      @Get('/null')
      @Endpoint(nullDefinition)
      empty(_input: ReturnType<typeof nullDefinition.input.parse>) {
        return null;
      }
    }
    @Module({ controllers: [Output], providers: [Corrupt] })
    class App {}
    const app = await VelaFactory.create(App);
    expect((await app.getHonoApp().request('/output/invalid')).status).toBe(500);
    const response = await app.getHonoApp().request('/output/null');
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    await app.close();
  });

  it('rejects competing response declarations during bootstrap', async () => {
    const definition = defineEndpoint({ input: z.object({}), output: z.string() });
    @Controller('/conflict')
    class Conflict {
      @Get()
      @HttpCode(202)
      @Endpoint(definition)
      read(_input: ReturnType<typeof definition.input.parse>) {
        return 'value';
      }
    }
    @Module({ controllers: [Conflict] })
    class App {}
    await expect(VelaFactory.create(App)).rejects.toThrow(
      'Conflict.read: @Endpoint owns the response status; remove @HttpCode and @Redirect',
    );
    @Controller('/redirect')
    class Redirecting {
      @Get()
      @Redirect('/elsewhere')
      @Endpoint(definition)
      read(_input: ReturnType<typeof definition.input.parse>) {
        return 'value';
      }
    }
    @Module({ controllers: [Redirecting] })
    class RedirectApp {}
    await expect(VelaFactory.create(RedirectApp)).rejects.toThrow(
      '@Endpoint owns the response status',
    );
  });
});

interface Actor {
  readonly id: string;
}
const ACTOR = new RequestContextKey<Actor>('test.endpoint-actor');

// Publishes request state the way authentication guards do.
@Injectable()
class ActorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const id = context.getRequest().headers.get('x-actor');
    if (!id) return false;
    context.getContainer()?.resolve(REQUEST_CONTEXT).set(ACTOR, { id });
    return true;
  }
}

describe('endpoint context parameters', () => {
  const routeInput = z.object({
    param: z.object({ id: z.string() }),
    query: z.object({ view: z.enum(['full', 'short']).default('short') }),
  });

  it('passes context decorators after the validated input', async () => {
    const CurrentActor = createParamDecorator((_data: undefined, context: ExecutionContext) =>
      context.getContainer()?.resolve(REQUEST_CONTEXT).get(ACTOR),
    );
    const DeferredActor = createLazyParamDecorator((_data: undefined, context: ExecutionContext) =>
      Promise.resolve(context.getContainer()?.resolve(REQUEST_CONTEXT).get(ACTOR)),
    );
    const definition = defineEndpoint({
      input: routeInput,
      output: z.object({
        id: z.string(),
        view: z.string(),
        actor: z.string(),
        deferred: z.string(),
        path: z.string(),
        address: z.string().nullable(),
        theme: z.string().optional(),
      }),
    });
    @Controller('/documents')
    @UseGuards(ActorGuard)
    class Documents {
      @Get('/:id')
      @Endpoint(definition)
      async read(
        input: z.output<typeof definition.input>,
        @CurrentActor() actor: Actor | undefined,
        @DeferredActor() loadActor: () => Promise<Actor | undefined>,
        @Req() request: VelaContext,
        @Res() response: VelaContext,
        @Ip() address: string | null,
        @Cookie('theme') theme: string | undefined,
      ) {
        // The endpoint still owns status and body; @Res() can add headers.
        response.header('x-rendered-by', 'endpoint');
        return {
          id: input.param.id,
          view: input.query.view,
          actor: actor?.id ?? 'anonymous',
          deferred: (await loadActor())?.id ?? 'anonymous',
          path: request.req.path,
          address,
          theme,
        };
      }
    }
    @Module({ controllers: [Documents], providers: [ActorGuard] })
    class App {}
    const app = await VelaFactory.create(App, { getClientIp: () => '203.0.113.7' });
    const response = await app.getHonoApp().request('/documents/d1?view=full', {
      headers: { 'x-actor': 'a1', cookie: 'theme=dark' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-rendered-by')).toBe('endpoint');
    expect(await response.json()).toEqual({
      id: 'd1',
      view: 'full',
      actor: 'a1',
      deferred: 'a1',
      path: '/documents/d1',
      address: '203.0.113.7',
      theme: 'dark',
    });
    await app.close();
  });

  it('keeps headers and cookies set through @Res() on binary and stream bodies', async () => {
    const binary = defineEndpoint({
      input: z.object({}),
      format: 'binary',
      contentType: 'application/pdf',
    });
    const stream = defineEndpoint({
      input: z.object({}),
      format: 'stream',
      contentType: 'text/event-stream',
    });
    @Controller('/exports')
    class Exports {
      @Get('/binary')
      @Endpoint(binary)
      download(_input: z.output<typeof binary.input>, @Res() response: VelaContext) {
        response.header('content-disposition', 'attachment; filename="report.pdf"');
        setCookie(response, 'downloaded', '1');
        return new Blob(['pdf']);
      }

      @Get('/stream')
      @Endpoint(stream)
      events(_input: z.output<typeof stream.input>, @Res() response: VelaContext) {
        response.header('cache-control', 'no-store');
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: ready\n\n'));
            controller.close();
          },
        });
      }
    }
    @Module({ controllers: [Exports] })
    class App {}
    const app = await VelaFactory.create(App);
    const file = await app.getHonoApp().request('/exports/binary');
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="report.pdf"');
    expect(file.headers.get('set-cookie')).toContain('downloaded=1');
    expect(await file.text()).toBe('pdf');
    const events = await app.getHonoApp().request('/exports/stream');
    expect(events.headers.get('content-type')).toBe('text/event-stream');
    expect(events.headers.get('cache-control')).toBe('no-store');
    expect(await events.text()).toBe('data: ready\n\n');
    await app.close();
  });

  it('resolves context after guards and input validation, with ordinary pipe semantics', async () => {
    let factoryCalls = 0;
    const CurrentActor = createParamDecorator((_data: undefined, context: ExecutionContext) => {
      factoryCalls += 1;
      return context.getContainer()?.resolve(REQUEST_CONTEXT).get(ACTOR);
    });
    const uppercaseActor: PipeTransform = {
      transform: (value) => {
        if (typeof value !== 'object' || value === null || !('id' in value)) return value;
        return { id: String(value.id).toUpperCase() };
      },
    };
    const seen: ArgumentMetadata['type'][] = [];
    const recording: PipeTransform = {
      transform(value, metadata) {
        seen.push(metadata.type);
        return value;
      },
    };
    const definition = defineEndpoint({
      input: routeInput,
      output: z.object({ id: z.string(), actor: z.string(), address: z.string().nullable() }),
    });
    @Controller('/ordered')
    @UseGuards(ActorGuard)
    class Ordered {
      @Get('/:id')
      @Endpoint(definition)
      read(
        input: z.output<typeof definition.input>,
        @Ip() address: string | null,
        @CurrentActor(undefined, uppercaseActor) actor: Actor | undefined,
      ) {
        return { id: input.param.id, actor: actor?.id ?? 'anonymous', address };
      }
    }
    @Module({ controllers: [Ordered], providers: [ActorGuard] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(recording);
    const hono = app.getHonoApp();

    // A rejecting guard runs before any argument work.
    expect((await hono.request('/ordered/o1')).status).toBe(403);
    // The input (parameter 0) is validated before context parameters resolve.
    const invalid = await hono.request('/ordered/o1?view=wide', { headers: { 'x-actor': 'a1' } });
    expect(invalid.status).toBe(400);
    expect(factoryCalls).toBe(0);
    expect(seen).toEqual(['custom']);

    seen.length = 0;
    const valid = await hono.request('/ordered/o1', { headers: { 'x-actor': 'a1' } });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ id: 'o1', actor: 'A1', address: null });
    expect(factoryCalls).toBe(1);
    // Shared pipes see the input first, then each context parameter in index order.
    expect(seen).toEqual(['custom', 'ip', 'custom']);
    await app.close();
  });

  const ownedReaders: Array<[string, ParameterDecorator, string]> = [
    ['@Body()', Body(), 'declare the value in the input json or form group'],
    ['@RawBody()', RawBody(), 'read raw bytes on a route without @Endpoint'],
    ['@Query()', Query('view'), 'declare the value in the input query group'],
    ['@Param()', Param('id'), 'declare the value in the input param group'],
    ['@Headers()', Headers('x-actor'), 'declare the value in the input header group'],
  ];

  async function bootstrapDecorated(decorator: ParameterDecorator, index: number): Promise<void> {
    const definition = defineEndpoint({ input: routeInput, output: z.string() });
    class Target {
      read(_input: unknown, _context?: unknown): string {
        return 'value';
      }
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(Target.prototype, 'read');
    if (!descriptor) throw new Error('missing method');
    decorator(Target.prototype, 'read', index);
    Endpoint(definition)(Target.prototype, 'read', descriptor);
    Get('/:id')(Target.prototype, 'read', descriptor);
    Controller('/target')(Target);
    @Module({ controllers: [Target] })
    class App {}
    await (await VelaFactory.create(App)).close();
  }

  it.each(ownedReaders)(
    'rejects %s because the endpoint input owns that data',
    async (name, decorator, remedy) => {
      await expect(bootstrapDecorated(decorator, 1)).rejects.toThrow(
        `Target.read: parameter 1 uses ${name}, which reads request data the @Endpoint input owns; ${remedy}`,
      );
    },
  );

  it('rejects any parameter decorator on the validated input', async () => {
    const CurrentActor = createParamDecorator(() => undefined);
    await expect(bootstrapDecorated(CurrentActor(), 0)).rejects.toThrow(
      'Target.read: @Endpoint passes its validated input as parameter 0',
    );
    await expect(bootstrapDecorated(Req(), 0)).rejects.toThrow('parameter 0');
  });

  it('accepts every context decorator after the input', async () => {
    const CurrentActor = createParamDecorator(() => undefined);
    const DeferredActor = createLazyParamDecorator(() => undefined);
    for (const decorator of [
      CurrentActor(),
      DeferredActor(),
      Req(),
      Res(),
      Ip(),
      Cookie('theme'),
    ]) {
      await expect(bootstrapDecorated(decorator, 1)).resolves.toBeUndefined();
    }
  });
});
