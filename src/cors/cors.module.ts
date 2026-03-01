import { cors } from 'hono/cors';
import { METADATA_KEYS } from '../constants';
import { defineMetadata } from '../metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Type } from '../container/types';
import type { DynamicModule } from '../module/types';
import type { NestMiddleware } from '../pipeline/types';
import { APP_MIDDLEWARE } from '../pipeline/tokens';
import { CORS_OPTIONS } from './cors.tokens';
import type { CorsOptions } from './cors.types';

export class CorsModule {
  static forRoot(options: CorsOptions = {}): DynamicModule {
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

    const moduleClass = class CorsDynamicModule {} as unknown as Type;
    Object.defineProperty(moduleClass, 'name', { value: 'CorsModule' });
    defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
    MetadataRegistry.setModuleOptions(moduleClass, {
      exports: [CORS_OPTIONS],
    });

    return {
      module: moduleClass,
      providers: [
        { provide: CORS_OPTIONS, useValue: options },
        { provide: APP_MIDDLEWARE, useValue: middleware },
      ],
    };
  }
}
