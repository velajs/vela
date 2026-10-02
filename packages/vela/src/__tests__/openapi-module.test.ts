import { describe, expect, it } from 'vitest';
import {
  APP_GUARD,
  Controller,
  Inject,
  Injectable,
  Scope,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
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
  OpenApiService,
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
      const document = await readDocument(await hono.request('/api/openapi.json'));
      expect(document.info).toEqual({ title: 'Users API', version: '2.0.0' });
      expect(Object.keys(document.paths)).toEqual(['/api/users']);
      expect((await hono.request('/openapi.json')).status).toBe(404);
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
      await readDocument(await second.getHonoApp().request('/v2/openapi.json'));
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
              path: '/docs.json',
              imports: [titles],
              inject: [TITLE],
              useFactory: (title) => ({ info: { title } }),
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

  it('rejects invalid paths and overlapping document/UI endpoints at registration', () => {
    for (const path of ['openapi.json', '/:id', '/docs/*', '//docs', '/docs?x=1']) {
      expect(() => OpenApiModule.forRoot({ path })).toThrow(/OpenApiModule path/);
    }
    expect(() => OpenApiModule.forRoot({ ui: 'scalar', uiPath: '/:id' })).toThrow(/uiPath/);
    expect(() => OpenApiModule.forRoot({ ui: 'scalar', uiPath: '/openapi.json' })).toThrow(
      /different/,
    );
  });

  it('runs global and request-scoped controller guards for both endpoints and disposes requests', async () => {
    const seen: number[] = [];
    const disposed: number[] = [];
    let serial = 0;
    @Injectable({ scope: Scope.REQUEST })
    class DocsGuard implements CanActivate {
      private readonly id = ++serial;
      canActivate(context: ExecutionContext) {
        seen.push(this.id);
        return context.switchToHttp().getRequest().headers.get('x-docs') === 'allowed';
      }
      dispose() {
        disposed.push(this.id);
      }
    }
    @Injectable()
    class GlobalGuard implements CanActivate {
      canActivate(context: ExecutionContext) {
        return context.switchToHttp().getRequest().headers.get('x-app') === 'allowed';
      }
    }
    @Module({
      imports: [
        UsersModule,
        OpenApiModule.forRoot({ ui: 'scalar', decorators: [UseGuards(DocsGuard)] }),
      ],
      providers: [GlobalGuard, defineProvider(APP_GUARD, { useExisting: GlobalGuard })],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    try {
      for (const path of ['/openapi.json', '/docs']) {
        for (const [headers, status] of [
          [{ 'x-docs': 'allowed' }, 403],
          [{ 'x-app': 'allowed' }, 403],
          [{ 'x-docs': 'allowed', 'x-app': 'allowed' }, 200],
          [{ 'x-app': 'allowed' }, 403],
        ] as const) {
          const response = await app.getHonoApp().request(path, { headers });
          expect(response.status).toBe(status);
          await response.text();
        }
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(6);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disposed).toEqual(expect.arrayContaining(seen));
    } finally {
      await app.close();
    }
  });

  it.each(['scalar', 'swagger', 'redoc'] as const)(
    'renders %s with custom assets, language and headers',
    async (ui) => {
      @Module({
        imports: [
          UsersModule,
          OpenApiModule.forRoot({
            ui,
            uiOptions: {
              title: '<Reference & "docs">',
              lang: 'pt-BR',
              scriptUrl: '/assets/ui.js?a=1&b=2',
              styleUrl: '/assets/ui.css',
              headers: { 'content-security-policy': "default-src 'self'" },
            },
          }),
        ],
      })
      class AppModule {}
      const app = await VelaFactory.create(AppModule, { globalPrefix: '/api' });
      try {
        const response = await app.getHonoApp().request('/api/docs');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(response.headers.get('content-security-policy')).toBe("default-src 'self'");
        const page = await response.text();
        expect(page).toContain('/api/openapi.json');
        expect(page).toContain('lang="pt-BR"');
        expect(page).toContain('&lt;Reference &amp; &quot;docs&quot;&gt;');
        expect(page).toContain('/assets/ui.js?a=1&amp;b=2');
        if (ui === 'swagger') expect(page).toContain('/assets/ui.css');
        expect(
          Object.keys(
            (await readDocument(await app.getHonoApp().request('/api/openapi.json'))).paths,
          ),
        ).toEqual(['/api/users']);
      } finally {
        await app.close();
      }
    },
  );

  it('uses application prefix exclusions and versioning for both the document and UI link', async () => {
    @Controller({ path: '/versioned', version: [1, 2] })
    class VersionedController {
      @Get() read() {
        return {};
      }
    }
    @Module({
      imports: [UsersModule, OpenApiModule.forRoot({ ui: 'scalar' })],
      controllers: [VersionedController],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, {
      globalPrefix: '/api',
      globalPrefixOptions: { exclude: ['/openapi.json', '/users'] },
      versioning: { prefix: false },
    });
    try {
      const document = await readDocument(await app.getHonoApp().request('/openapi.json'));
      expect(Object.keys(document.paths)).toEqual([
        '/api/1/versioned',
        '/api/2/versioned',
        '/users',
      ]);
      expect(await (await app.getHonoApp().request('/api/docs')).text()).toContain(
        'data-url="/openapi.json"',
      );
    } finally {
      await app.close();
    }
  });

  it('exports the service for custom controllers without mounting default routes', async () => {
    @ApiExclude()
    @Controller('/reference')
    class CustomDocsController {
      constructor(@Inject(OpenApiService) private readonly docs: OpenApiService) {}
      @Get('/schema') schema() {
        return this.docs.getDocument();
      }
      @Get() page() {
        return this.docs.renderUi({
          ui: 'swagger',
          specUrl: '/api/reference/schema?value=</script>&"',
        });
      }
    }
    const transformDocument = (document: OpenApiDocument): OpenApiDocument => ({
      ...document,
      info: { ...document.info, title: 'Customized' },
    });
    @Module({
      imports: [UsersModule, OpenApiModule.forRoot({ mount: false, transformDocument })],
      controllers: [CustomDocsController],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { globalPrefix: '/api', diagnostics: 'throw' });
    try {
      const document = await readDocument(await app.getHonoApp().request('/api/reference/schema'));
      expect(document).toEqual(
        createOpenApiDocument(AppModule, { globalPrefix: '/api', transformDocument }),
      );
      expect(document.info.title).toBe('Customized');
      expect((await app.getHonoApp().request('/api/openapi.json')).status).toBe(404);
      expect((await app.getHonoApp().request('/api/docs')).status).toBe(404);
      const page = await (await app.getHonoApp().request('/api/reference')).text();
      expect(page).not.toContain('value=</script>');
      expect(page).toContain('url: "/api/reference/schema?value=');
    } finally {
      await app.close();
    }
  });
});
