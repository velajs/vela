import { cors } from 'hono/cors';
import type { DynamicModule } from '../module/types';
import { stableHash } from '../module/stable-hash';
import type { NestMiddleware } from '../pipeline/types';
import { APP_MIDDLEWARE } from '../pipeline/tokens';
import { CORS_OPTIONS } from './cors.tokens';
import type { CorsOptions } from './cors.types';

export class CorsModule {
  static forRoot(options: CorsOptions & { key?: string } = {}): DynamicModule {
    const corsMiddleware = cors({
      origin: options.origin ?? '*',
      allowMethods: options.allowMethods,
      allowHeaders: options.allowHeaders,
      exposeHeaders: options.exposeHeaders,
      credentials: options.credentials,
      maxAge: options.maxAge,
    });

    const middleware: NestMiddleware = {
      use: (c, next) => corsMiddleware(c, next) as Promise<Response | void>,
    };

    return {
      module: CorsModule,
      key: options.key ?? stableHash(options),
      providers: [
        { provide: CORS_OPTIONS, useValue: options },
        { provide: APP_MIDDLEWARE, useValue: middleware },
      ],
      exports: [CORS_OPTIONS],
    };
  }
}
