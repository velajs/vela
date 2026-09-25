import type { VelaHono as Hono } from './http/hono.types';
import { findRequestContainer } from './http/request-container';
import { HTTPException } from 'hono/http-exception';
import { VelaApplicationContext } from './application-context';
import type { Container } from './container/container';
import type { Type } from './container/types';
import { defineProvider } from './container/types';
import { APP_EXCEPTION_HANDLER } from './pipeline/tokens';
import type { ExceptionHandler } from './exceptions/exception-handler';
import { isClientErrorStatus } from './exceptions/render-http-error';
import { resolveErrorReporter } from './exceptions/reporter';
import { buildMiddlewareExecutionContext } from './http/execution-context';
import { sendHttpError } from './http/error-response';
import type { CorsOptions } from './http/cors';
import type { RouteDescription, RouteManager } from './http/route.manager';
import type { RoutePathOptions } from './http/route-paths';
import type { MountOpenApiOptions, OpenApiUi } from './openapi/types';
import { renderScalarUi } from './openapi/scalar-ui';
import { renderSwaggerUi } from './openapi/swagger-ui';
import { renderRedocUi } from './openapi/redoc-ui';
import type { FilterType, GuardType, InterceptorType, PipeType } from './registry/types';

/**
 * The HTTP application: an application context ({@link VelaApplicationContext})
 * with the routes built on Hono, as Nest's `NestApplication` extends its
 * application context.
 */
export class VelaApplication extends VelaApplicationContext {
  private honoApp: Hono | null = null;

  constructor(
    container: Container,
    private readonly routeManager: RouteManager,
  ) {
    super(container);
  }

  /** Pre-build routes (handles async CRUD imports). Called by VelaFactory. */
  async initRoutes(): Promise<void> {
    this.honoApp = await this.routeManager.build();

    // Last line of defense for the HTTP edge. HandlerExecutor's catch tail
    // only sees controller-handler errors; a raw Hono middleware (or any
    // hono-level throw that bypasses route.manager's wrapMiddlewareWithFilters)
    // would otherwise reach Hono's default error handler unreported and
    // unredacted. `onError` funnels it through the same report-first + canonical
    // redacted body path every other edge uses.
    this.honoApp.onError((err, c) => {
      const reporter = resolveErrorReporter(findRequestContainer(c) ?? this.getContainer());
      // A Hono HTTPException with a 4xx status (an auth challenge, say) is a
      // deliberate client response, not a server fault. Everything else is
      // reported, as on the handler edge, including one with a status the
      // edge cannot answer (302, 404.5, NaN, 700), which renders as a 500
      // unless it carries its own `res`.
      if (!(err instanceof HTTPException) || !isClientErrorStatus(err.status)) {
        reporter.report(err, { edge: 'hono', source: `${c.req.method} ${c.req.path}` });
      }
      // The raw edge only sees unplanned throws, so exception-owned 5xx bodies
      // (and every 5xx message) are redacted to the status title.
      return sendHttpError(c, err, reporter, buildMiddlewareExecutionContext(c), true);
    });
  }

  private getApp(): Hono {
    if (!this.honoApp) {
      throw new Error(
        'Routes not built. This should not happen — VelaFactory.create() builds routes automatically.',
      );
    }
    return this.honoApp;
  }

  get fetch(): Hono['fetch'] {
    return this.getApp().fetch;
  }

  getHonoApp(): Hono {
    return this.getApp();
  }

  /**
   * Every explicit controller route as the framework registered it (fully
   * composed paths — the `vela route list` seam). Requires built routes;
   * contributed routes (`@velajs/crud`) mount directly on Hono and are
   * observable via `getHonoApp().routes` instead.
   */
  describeRoutes(): RouteDescription[] {
    this.getApp(); // same routes-not-built guard as every HTTP accessor
    return this.routeManager.getRouteDescriptions();
  }

  /** The global route prefix in effect ('' when none). */
  getGlobalPrefix(): string {
    return this.routeManager.getGlobalPrefix();
  }

  /**
   * Enable CORS for every route, as Nest's `app.enableCors(options)`: Hono's
   * `cors` middleware answers preflights and stamps its headers before body
   * limits, routing and guards. Takes effect on the next request; a later call
   * replaces the options. `VelaFactory.create(root, { cors })` does the same
   * at construction.
   */
  enableCors(options: CorsOptions = {}): this {
    this.routeManager.enableCors(options);
    return this;
  }

  /**
   * How controller routes compose into served paths (global prefix and its
   * exclusions, URI versioning). Spread into `createOpenApiDocument` so the
   * document matches the served routes.
   */
  getRoutePathOptions(): RoutePathOptions {
    return this.routeManager.getRoutePathOptions();
  }

  // Pipeline components — applied at request time, no rebuild needed

  useGlobalPipes(...pipes: PipeType[]): this {
    this.routeManager.useGlobalPipes(...pipes);
    return this;
  }

  useGlobalGuards(...guards: GuardType[]): this {
    this.routeManager.useGlobalGuards(...guards);
    return this;
  }

  useGlobalInterceptors(...interceptors: InterceptorType[]): this {
    this.routeManager.useGlobalInterceptors(...interceptors);
    return this;
  }

  useGlobalFilters(...filters: FilterType[]): this {
    this.routeManager.useGlobalFilters(...filters);
    return this;
  }

  /**
   * Register the application-wide {@link ExceptionHandler} imperatively — the
   * sibling of `ErrorsModule.forRoot({ handler })`. A class is constructed
   * through DI (`useClass`); a plain handler object is registered verbatim
   * (`useValue`). Consumed by `resolveErrorReporter` at every transport edge,
   * so it takes effect on the next request without a rebuild.
   *
   * ```ts
   * app.useGlobalExceptionHandler({ report: (e) => sentry.capture(e) });
   * ```
   */
  useGlobalExceptionHandler(handler: Type<ExceptionHandler> | ExceptionHandler): this {
    this.getContainer().register(
      typeof handler === 'function'
        ? defineProvider(APP_EXCEPTION_HANDLER, { useClass: handler })
        : defineProvider(APP_EXCEPTION_HANDLER, { useValue: handler }),
    );
    return this;
  }

  /**
   * Serve a pre-built OpenAPI document and one or more interactive doc UIs
   * (Swagger UI, Scalar, ReDoc) on the underlying Hono app, mirroring the
   * hono-crud docs convention. Edge-safe: each UI is a tiny self-contained
   * HTML shell that loads its renderer from a CDN at runtime so nothing is
   * bundled server-side and no extra dependency is required.
   *
   * Defaults: spec at `/openapi.json`, Scalar at `/scalar`, Swagger UI at
   * `/docs`, ReDoc at `/redoc`.
   *
   * ```ts
   * const doc = createOpenApiDocument(AppModule);
   * app.mountOpenApi({ document: doc });            // Scalar @ /scalar
   * app.mountOpenApi({ document: doc, ui: 'all' }); // swagger + scalar + redoc
   * ```
   */
  mountOpenApi(options: MountOpenApiOptions): this {
    const app = this.getApp();
    const doc = options.document;
    const title = options.title;

    const specPath = options.specPath ?? '/openapi.json';
    app.get(specPath, (c) => c.json(doc));

    // Normalize the requested UI set. Default is Scalar only.
    const uiOption = options.ui;
    let uis: OpenApiUi[];
    if (uiOption === undefined) {
      uis = ['scalar'];
    } else if (uiOption === 'all') {
      uis = ['swagger', 'scalar', 'redoc'];
    } else if (Array.isArray(uiOption)) {
      uis = uiOption;
    } else {
      uis = [uiOption];
    }

    for (const ui of uis) {
      if (ui === 'swagger') {
        const path = options.swaggerPath ?? '/docs';
        const html = renderSwaggerUi(specPath, title);
        app.get(path, (c) => c.html(html));
      } else if (ui === 'redoc') {
        const path = options.redocPath ?? '/redoc';
        const html = renderRedocUi(specPath, title);
        app.get(path, (c) => c.html(html));
      } else {
        const path = options.scalarPath ?? '/scalar';
        const html = renderScalarUi(specPath, title);
        app.get(path, (c) => c.html(html));
      }
    }

    return this;
  }
}
