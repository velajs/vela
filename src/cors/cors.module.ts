import { cors } from 'hono/cors';
import { defineModule } from '../module/define-module';
import type { NestMiddleware } from '../pipeline/types';
import { APP_MIDDLEWARE } from '../pipeline/tokens';
import { CORS_OPTIONS } from './cors.tokens';
import type { CorsOptions } from './cors.types';

function buildCorsMiddleware(options: CorsOptions): NestMiddleware {
  const corsMiddleware = cors({
    origin: options.origin ?? '*',
    allowMethods: options.allowMethods,
    allowHeaders: options.allowHeaders,
    exposeHeaders: options.exposeHeaders,
    credentials: options.credentials,
    maxAge: options.maxAge,
  });
  return { use: (c, next) => corsMiddleware(c, next) as Promise<Response | void> };
}

const { ConfigurableModuleClass } = defineModule<CorsOptions>({
  name: 'Cors',
  optionsToken: CORS_OPTIONS,
  setup: ({ OPTIONS }) => ({
    providers: [
      {
        provide: APP_MIDDLEWARE,
        useFactory: (options: CorsOptions) => buildCorsMiddleware(options),
        inject: [OPTIONS],
      },
    ],
    exports: [OPTIONS],
  }),
});

export class CorsModule extends ConfigurableModuleClass {}
