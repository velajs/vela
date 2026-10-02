import { HttpMethod } from '../constants';
import { Inject, Injectable } from '../container/decorators';
import { InjectionToken, type Type } from '../container/types';
import { createRouteComposer, VERSION_NEUTRAL } from '../http/route-paths';
import { RouteManager } from '../http/route.manager';
import { collectControllers } from '../module/graph';
import { ROOT_MODULE } from '../module/root-module';
import type { DynamicModule } from '../registry/types';
import { openApiDocumentFor } from './document';
import { renderScalarUi } from './scalar-ui';
import { renderSwaggerUi } from './swagger-ui';
import { renderRedocUi } from './redoc-ui';
import type { OpenApiDocument, OpenApiModuleOptions, RenderOpenApiUiOptions } from './types';

export const OPENAPI_OPTIONS = new InjectionToken<OpenApiModuleOptions>('OpenApiOptions');

/** Injectable documentation for this application, including testing-module overrides. */
@Injectable()
export class OpenApiService {
  private document: OpenApiDocument | undefined;

  constructor(
    @Inject(OPENAPI_OPTIONS) private readonly options: OpenApiModuleOptions,
    @Inject(RouteManager) private readonly routes: RouteManager,
    @Inject(ROOT_MODULE) private readonly root: Type | DynamicModule,
  ) {}

  /** Lazily build and cache the document for this application only. */
  getDocument(): OpenApiDocument {
    if (this.document) return this.document;
    const served = [...new Set(this.routes.getControllers().map(({ controller }) => controller))];
    const declared = collectControllers(this.root);
    const rank = new Map(declared.map((controller, index) => [controller, index]));
    const controllers = served.toSorted(
      (a, b) => (rank.get(a) ?? declared.length) - (rank.get(b) ?? declared.length),
    );
    this.document = openApiDocumentFor(controllers, {
      ...this.options,
      ...this.routes.getRoutePathOptions(),
    });
    return this.document;
  }

  /** Render the configured UI, or override its presentation and JSON URL in a custom controller. */
  renderUi(overrides: RenderOpenApiUiOptions = {}): Response {
    const options = { ...this.options.uiOptions, ...overrides };
    const ui = options.ui ?? this.options.ui ?? 'scalar';
    const specUrl =
      options.specUrl ??
      createRouteComposer(this.routes.getRoutePathOptions())(
        '',
        { path: this.options.path ?? '/openapi.json', method: HttpMethod.GET },
        VERSION_NEUTRAL,
      )[0]!.path;
    const title = options.title ?? this.getDocument().info.title;
    const render =
      ui === 'swagger' ? renderSwaggerUi : ui === 'redoc' ? renderRedocUi : renderScalarUi;
    return new Response(render(specUrl, title, options), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        ...this.options.uiOptions?.headers,
        ...overrides.headers,
      },
    });
  }
}
