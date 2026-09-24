import { InjectionToken } from '../container/types';
import { Controller } from '../http/decorators';
import { registerRouteContributor } from '../http/route-contributor';
import { defineMetadata } from '../metadata';
import { defineModule } from '../module/define-module';
import { ROOT_MODULE } from '../module/root-module';
import type { DynamicModule } from '../registry/types';
import { createOpenApiDocument } from './document';
import type { CreateOpenApiDocumentOptions, OpenApiDocument } from './types';

export interface OpenApiModuleOptions extends Omit<CreateOpenApiDocumentOptions, 'globalPrefix'> {
  /**
   * Path the JSON document is served on, exactly as given: the global prefix
   * is not prepended. Default `/openapi.json`.
   */
  path?: string;
}

const DOCUMENT_ENDPOINT = 'vela:openapi:document-endpoint';
const CONCRETE_PATH = /^(?:\/[A-Za-z0-9._~-]+)+$/;

function isOptions(value: unknown): value is OpenApiModuleOptions {
  return typeof value === 'object' && value !== null;
}

registerRouteContributor({
  id: 'vela:openapi',
  claimsMetaKey: DOCUMENT_ENDPOINT,
  async buildRoutes(app, context) {
    const token = context.meta;
    if (!(token instanceof InjectionToken)) throw new TypeError('Invalid OpenApiModule metadata.');
    const [owner, ...others] = context.container.getOwnerModuleIds(context.controller);
    if (owner === undefined || others.length > 0) {
      throw new Error('An OpenApiModule document endpoint must have exactly one module owner.');
    }
    const options: unknown = await context.container.resolveAsync(token, owner);
    if (!isOptions(options)) throw new TypeError('OpenApiModule options must be an object.');
    const { path = '/openapi.json', ...documentOptions } = options;
    if (typeof path !== 'string' || !CONCRETE_PATH.test(path)) {
      throw new TypeError(
        `OpenApiModule path must be a concrete absolute path such as '/openapi.json'; got '${String(path)}'.`,
      );
    }
    if (app.routes.some((route) => route.path === path && route.method !== 'ALL')) {
      throw new Error(`OpenApiModule path '${path}' conflicts with an existing route.`);
    }

    // The application root, as passed to the factory. The document is built on
    // the first request and kept for this application only: every application
    // (one per environment on Workers) documents its own global prefix.
    const root = context.container.resolve(ROOT_MODULE);
    const globalPrefix = context.globalPrefix;
    let document: OpenApiDocument | undefined;
    app.get(path, (c) => {
      document ??= createOpenApiDocument(root, { ...documentOptions, globalPrefix });
      return c.json(document);
    });
  },
});

/**
 * Serves the application's OpenAPI 3.1 document, Nest's `SwaggerModule`
 * without the setup call:
 *
 * ```ts
 * @Module({
 *   imports: [OpenApiModule.forRoot({ path: '/openapi.json', info: { title: 'API', version: '1.0.0' } })],
 * })
 * export class AppModule {}
 * ```
 *
 * The document covers the application root (`ROOT_MODULE`) under its global
 * prefix. The document route itself, and anything marked `@ApiExclude()`, is
 * left out. Routes run no guards: put a document you want to protect behind
 * consumer middleware.
 */
const { ConfigurableModuleClass } = defineModule<OpenApiModuleOptions>({
  name: 'OpenApi',
  setup: ({ OPTIONS }) => {
    // One endpoint class per module instance, like RpcModule's: it declares no
    // routes of its own and carries the options token its contributor reads.
    class OpenApiDocumentEndpoint {}
    Controller()(OpenApiDocumentEndpoint);
    defineMetadata(DOCUMENT_ENDPOINT, OPTIONS, OpenApiDocumentEndpoint);
    return { controllers: [OpenApiDocumentEndpoint] };
  },
});

type OpenApiModuleRegistration = Parameters<(typeof ConfigurableModuleClass)['forRoot']>[0];

export class OpenApiModule extends ConfigurableModuleClass {
  /** Serve the application's document; every option is optional. */
  static override forRoot(options: OpenApiModuleRegistration = {}): DynamicModule {
    return super.forRoot(options);
  }
}
