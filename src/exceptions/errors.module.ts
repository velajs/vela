import { CORE_CATALOG, composeCatalogs, type Catalog } from '@velajs/errors';
import type { ProviderOptions, Type } from '../container/types';
import { defineModule } from '../module/define-module';
import { APP_EXCEPTION_HANDLER, ERROR_CATALOG } from '../pipeline/tokens';
import type { ExceptionHandler } from './exception-handler';

/**
 * Options for {@link ErrorsModule.forRoot}. Both fields are optional — an empty
 * `forRoot()` provides just the core catalog (`CORE_CATALOG`) and no custom
 * handler, which is the framework default anyway.
 */
export interface ErrorsModuleOptions {
  /**
   * App-specific catalogs composed **onto** `CORE_CATALOG` via
   * {@link composeCatalogs}. Composition is eager (at `forRoot` call time), so a
   * duplicate code across two catalogs fails fast with `duplicate error code`.
   */
  catalogs?: Catalog<string>[];
  /**
   * The application-wide {@link ExceptionHandler}. A class is wired with
   * `useClass` (constructed through DI); a plain handler object with `useValue`.
   */
  handler?: Type<ExceptionHandler> | ExceptionHandler;
}

/** Lower a `handler` option to an {@link APP_EXCEPTION_HANDLER} provider. */
const handlerProvider = (handler: Type<ExceptionHandler> | ExceptionHandler): ProviderOptions =>
  typeof handler === 'function'
    ? { provide: APP_EXCEPTION_HANDLER, useClass: handler }
    : { provide: APP_EXCEPTION_HANDLER, useValue: handler };

const { ConfigurableModuleClass } = defineModule<ErrorsModuleOptions>({
  name: 'Errors',
  setup: ({ options }) => {
    const providers: ProviderOptions[] = [
      {
        provide: ERROR_CATALOG,
        useValue: composeCatalogs(CORE_CATALOG, ...(options.catalogs ?? [])),
      },
    ];
    const exports: Array<typeof ERROR_CATALOG | typeof APP_EXCEPTION_HANDLER> = [ERROR_CATALOG];
    if (options.handler) {
      providers.push(handlerProvider(options.handler));
      exports.push(APP_EXCEPTION_HANDLER);
    }
    return { providers, exports };
  },
});

/**
 * Registers the application-wide error surface: the composed
 * {@link ERROR_CATALOG} that every transport edge redacts against, and an
 * optional {@link APP_EXCEPTION_HANDLER}. The imperative sibling is
 * `app.useGlobalExceptionHandler(handler)`.
 *
 * ```ts
 * @Module({
 *   imports: [ErrorsModule.forRoot({ catalogs: [ordersCatalog], handler: SentryHandler })],
 * })
 * class AppModule {}
 * ```
 */
export class ErrorsModule extends ConfigurableModuleClass {}
