/**
 * `CrudModule` — defineModule-based (the queue-module template), EAGER by
 * design: adapter capability checks, tenant affirmations, and schema
 * derivation are load-time fail-fast wiring, exactly what MODULE_AUTHORING
 * says not to defer.
 *
 * - `forRoot({ adapter })` / `forRootAsync` provide the app-wide default
 *   adapter (`CRUD_DEFAULT_ADAPTER`).
 * - `forFeature([{ path, model, ... }])` synthesizes a controller per
 *   headless resource and registers its compiled engine under
 *   `crudResourceToken(name)` (options-derived providers, queue-style).
 */

import { Container, defineModule, stableHash } from '@velajs/vela';
import type { DynamicModule, ProviderOptions } from '@velajs/vela';
import type { CrudAdapter } from './adapter/contract';
import { ConfigurationException } from './envelope/errors';
import { defineResource } from './kernel/resource';
import {
  CRUD_DEFAULT_ADAPTER,
  CRUD_DEFAULT_AUDIT_STORE,
  CRUD_DEFAULT_VERSIONING_STORE,
  crudResourceToken,
} from './crud.tokens';
import { resourceNames } from './crud.types';
import { toEngineConfig } from './stamp-routes';
import { synthesizeController, type CrudFeatureResource } from './synthesize-controller';
import type { VersioningStore } from './versioning/index';
import type { AuditStore } from './audit/index';

export interface CrudModuleOptions {
  /** The app-wide default `CrudAdapter` (per-resource `adapter` overrides it). */
  adapter: CrudAdapter;
  /** App-wide default version-history store (per-resource `versioningStore` overrides it). */
  versioningStore?: VersioningStore;
  /** App-wide default audit-log store (per-resource `auditStore` overrides it). */
  auditStore?: AuditStore;
}

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<CrudModuleOptions>({
  name: 'Crud',
  key: () => stableHash({ module: 'crud-root' }),
  setup: ({ OPTIONS }) => ({
    providers: [
      {
        provide: CRUD_DEFAULT_ADAPTER,
        useFactory: (options: CrudModuleOptions) => {
          if (!options.adapter) {
            throw new ConfigurationException(
              'CrudModule.forRoot requires an adapter: forRoot({ adapter: memoryAdapter(...) })',
            );
          }
          return options.adapter;
        },
        inject: [OPTIONS],
      },
      // Optional app-wide default stores (may be undefined — resources that do
      // not enable versioning/audit never resolve them).
      {
        provide: CRUD_DEFAULT_VERSIONING_STORE,
        useFactory: (options: CrudModuleOptions) => options.versioningStore,
        inject: [OPTIONS],
      },
      {
        provide: CRUD_DEFAULT_AUDIT_STORE,
        useFactory: (options: CrudModuleOptions) => options.auditStore,
        inject: [OPTIONS],
      },
    ],
    exports: [CRUD_DEFAULT_ADAPTER, CRUD_DEFAULT_VERSIONING_STORE, CRUD_DEFAULT_AUDIT_STORE],
  }),
});

export class CrudModule extends ConfigurableModuleClass {
  /**
   * Mounts headless resources. Controllers are synthesized (and their routes
   * stamped) synchronously here; the compiled engine resource is provided
   * under `crudResourceToken(name)` for anything that wants to dispatch verbs
   * programmatically.
   */
  static forFeature(resources: CrudFeatureResource[]): DynamicModule {
    const controllers = resources.map((feature) => synthesizeController(feature));
    const providers: ProviderOptions[] = resources.map((feature) => {
      const { path: _path, ...config } = feature;
      const names = resourceNames(config);
      return {
        provide: crudResourceToken(names.singular),
        useFactory: (container: Container) => {
          const adapter = config.adapter ?? resolveDefault(container, names.singular);
          const engineConfig = toEngineConfig(config, adapter);
          engineConfig.versioningStore ??= resolveOptional(
            container,
            CRUD_DEFAULT_VERSIONING_STORE,
          );
          engineConfig.auditStore ??= resolveOptional(container, CRUD_DEFAULT_AUDIT_STORE);
          return defineResource(names.singular, engineConfig);
        },
        inject: [Container],
      };
    });

    return {
      module: CrudModule,
      key: `feature:${resources.map((r) => r.path).join(',')}`,
      controllers,
      providers,
      exports: resources.map((feature) => {
        const { path: _path, ...config } = feature;
        return crudResourceToken(resourceNames(config).singular);
      }),
    };
  }
}

function resolveDefault(container: Container, resource: string): CrudAdapter {
  if (!container.has(CRUD_DEFAULT_ADAPTER)) {
    throw new ConfigurationException(
      `CrudModule.forFeature('${resource}'): no adapter — pass 'adapter' on the resource or ` +
        'import CrudModule.forRoot({ adapter }) first',
    );
  }
  return container.resolve(CRUD_DEFAULT_ADAPTER);
}

/** Resolve an optional forRoot default store; `undefined` when unregistered. */
function resolveOptional<T>(
  container: Container,
  token: Parameters<Container['resolve']>[0],
): T | undefined {
  if (!container.has(token)) return undefined;
  return container.resolve(token) as T | undefined;
}

export { MODULE_OPTIONS_TOKEN as CRUD_MODULE_OPTIONS };
