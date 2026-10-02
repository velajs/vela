import { Inject } from '../container/decorators';
import { Controller, Get } from '../http/decorators';
import { VERSION_NEUTRAL } from '../http/version';
import { defineModule } from '../module/define-module';
import type { DynamicModule } from '../registry/types';
import { ApiExclude } from './decorators';
import { OPENAPI_OPTIONS, OpenApiService } from './openapi.service';
import type { OpenApiModuleOptions } from './types';

export type { OpenApiModuleOptions } from './types';

const CONCRETE_PATH = /^(?:\/[A-Za-z0-9._~-]+)+$/;
type StructuralOptions = 'path' | 'ui' | 'uiPath' | 'mount' | 'decorators';

function validatePath(name: string, path: string): void {
  if (typeof path !== 'string' || !CONCRETE_PATH.test(path)) {
    throw new TypeError(`OpenApiModule ${name} must be a concrete absolute path; got '${path}'.`);
  }
}

/** Application-scoped documentation with the normal controller pipeline and optional UI. */
const { ConfigurableModuleClass } = defineModule<OpenApiModuleOptions, StructuralOptions>({
  name: 'OpenApi',
  optionsToken: OPENAPI_OPTIONS,
  structural: ['path', 'ui', 'uiPath', 'mount', 'decorators'],
  defaults: { path: '/openapi.json', uiPath: '/docs', mount: true },
  key: () => 'default',
  setup: ({ options }) => {
    const { path = '/openapi.json', uiPath = '/docs', ui, mount = true, decorators = [] } = options;
    validatePath('path', path);
    validatePath('uiPath', uiPath);
    if (ui !== undefined && !['scalar', 'swagger', 'redoc'].includes(ui)) {
      throw new TypeError(`Unknown OpenApiModule UI '${ui}'.`);
    }
    if (ui && path === uiPath) {
      throw new TypeError('OpenApiModule path and uiPath must be different.');
    }
    if (!mount) return { providers: [OpenApiService], exports: [OpenApiService] };

    @ApiExclude()
    @Controller({ version: VERSION_NEUTRAL })
    class OpenApiController {
      constructor(@Inject(OpenApiService) private readonly docs: OpenApiService) {}

      @Get(path)
      document() {
        return this.docs.getDocument();
      }

      page() {
        return this.docs.renderUi();
      }
    }
    if (ui) {
      Get(uiPath)(
        OpenApiController.prototype,
        'page',
        Object.getOwnPropertyDescriptor(OpenApiController.prototype, 'page')!,
      );
    }
    // Like TypeScript's stacked decorators, the first declared decorator runs last.
    for (const decorator of [...decorators].reverse()) {
      const replacement = decorator(OpenApiController);
      if (replacement !== undefined && replacement !== OpenApiController) {
        throw new TypeError(
          'OpenApiModule decorators must annotate the controller, not replace it.',
        );
      }
    }
    return {
      controllers: [OpenApiController],
      providers: [OpenApiService],
      exports: [OpenApiService],
    };
  },
});

type OpenApiModuleRegistration = Parameters<(typeof ConfigurableModuleClass)['forRoot']>[0];

export class OpenApiModule extends ConfigurableModuleClass {
  /** Serve the application's document; every option is optional. */
  static override forRoot(options: OpenApiModuleRegistration = {}): DynamicModule {
    return super.forRoot(options);
  }
}
