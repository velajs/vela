import { describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  InjectionToken,
  Module,
  VelaFactory,
  defineProvider,
  type DynamicModule,
} from '../index.js';
import { defineMetadata, registerRouteContributor } from '../module-kit.js';
import {
  ApiExclude,
  OpenApiModule,
  createOpenApiDocument,
  isApiExcluded,
  type OpenApiDocument,
} from '../openapi/index.js';

@Controller('/users')
class UsersController {
  @Get()
  list() {
    return [];
  }

  @Get('/internal')
  @ApiExclude()
  internal() {
    return { ok: true };
  }
}

@ApiExclude()
@Controller('/ops')
class OpsController {
  @Get()
  status() {
    return { ok: true };
  }
}

@Module({ controllers: [UsersController, OpsController] })
class UsersModule {}

async function readDocument(response: Response): Promise<OpenApiDocument> {
  expect(response.status).toBe(200);
  return response.json();
}

describe('@ApiExclude', () => {
  it('omits an excluded controller or handler from the document', () => {
    const document = createOpenApiDocument(UsersModule);
    expect(Object.keys(document.paths)).toEqual(['/users']);
    expect(isApiExcluded(OpsController)).toBe(true);
    expect(isApiExcluded(UsersController, 'internal')).toBe(true);
    expect(isApiExcluded(UsersController, 'list')).toBe(false);
  });
});

describe('OpenApiModule', () => {
  it("serves the application's document, under its global prefix, without itself", async () => {
    @Module({
      imports: [
        UsersModule,
        OpenApiModule.forRoot({
          path: '/openapi.json',
          info: { title: 'Users API', version: '2.0.0' },
        }),
      ],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { globalPrefix: '/api' });
    try {
      const hono = app.getHonoApp();
      const document = await readDocument(await hono.request('/openapi.json'));
      expect(document.info).toEqual({ title: 'Users API', version: '2.0.0' });
      expect(Object.keys(document.paths)).toEqual(['/api/users']);
      expect((await hono.request('/api/openapi.json')).status).toBe(404);
      // Excluded routes are undocumented, not unserved.
      expect((await hono.request('/api/users/internal')).status).toBe(200);
      expect((await hono.request('/api/ops')).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('builds the document on the first request and reuses it for that application', async () => {
    const CLAIM = 'test:openapi-module:counting';
    let builds = 0;
    registerRouteContributor({
      id: 'test:openapi-module:counting',
      claimsMetaKey: CLAIM,
      buildRoutes() {},
      buildOpenApiPaths() {
        builds++;
        return {};
      },
    });
    @Controller('/counted')
    class CountedController {}
    defineMetadata(CLAIM, true, CountedController);

    @Module({ imports: [OpenApiModule.forRoot()], controllers: [CountedController] })
    class AppModule {}

    const first = await VelaFactory.create(AppModule);
    const second = await VelaFactory.create(AppModule, { globalPrefix: '/v2' });
    try {
      expect(builds).toBe(0);
      const a = await readDocument(await first.getHonoApp().request('/openapi.json'));
      const b = await readDocument(await first.getHonoApp().request('/openapi.json'));
      expect(builds).toBe(1);
      expect(b).toEqual(a);
      await readDocument(await second.getHonoApp().request('/openapi.json'));
      expect(builds).toBe(2);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('documents a DynamicModule root and reads options through DI', async () => {
    const TITLE = new InjectionToken<string>('test.openapi.title');
    @Module({})
    class TitleModule {}
    const titles: DynamicModule = {
      module: TitleModule,
      providers: [defineProvider(TITLE, { useValue: 'From DI' })],
      exports: [TITLE],
    };

    @Module({})
    class RootModule {
      static forRoot(): DynamicModule {
        return {
          module: RootModule,
          imports: [
            UsersModule,
            OpenApiModule.forRootAsync({
              imports: [titles],
              inject: [TITLE],
              useFactory: (title) => ({ path: '/docs.json', info: { title } }),
            }),
          ],
        };
      }
    }

    const app = await VelaFactory.create(RootModule.forRoot());
    try {
      const document = await readDocument(await app.getHonoApp().request('/docs.json'));
      expect(document.info.title).toBe('From DI');
      expect(Object.keys(document.paths)).toEqual(['/users']);
    } finally {
      await app.close();
    }
  });

  it('rejects a document path that is not a concrete absolute path', async () => {
    @Module({ imports: [OpenApiModule.forRoot({ path: 'openapi.json' })] })
    class AppModule {}

    await expect(VelaFactory.create(AppModule)).rejects.toThrow(/OpenApiModule path/);
  });
});
