/**
 * CRUD module wiring. Application-owned adapters validate at bootstrap;
 * request factories acquire and validate only inside a managed invocation.
 * forFeature mounts controllers and provides invocation-scoped compiled
 * resources under crudResourceToken(name, database).
 */

import {
  Inject,
  Injectable,
  defineModule,
  defineProvider,
  EXECUTION_LIFETIME,
  Scope,
  ModuleRef,
} from '@velajs/vela';
import {
  Container,
  DiscoveryService,
  MetadataRegistry,
  referenceKey,
} from '@velajs/vela/module-kit';
import type { DynamicModule, Type, Token, ModuleImport, ExecutionLifetime } from '@velajs/vela';
import type { InferTokens, FactoryInject } from '@velajs/vela/module-kit';
import type { CrudDatabaseLease } from './request-databases';
import type { CrudAdapter } from './adapter/contract';
import { ConfigurationException } from './envelope/errors';
import type { CrudDatabaseRegistry } from './databases';
import { resolveCrudDatabase, resolveCrudDatabaseSync } from './resolve-database';
import { compileResource } from './kernel/resource';
import {
  CRUD_DATABASES,
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
  adapter?: Pick<CrudAdapter, 'runtime'>;
  /** Named database registrations; construct from environment-specific providers. */
  databases?: CrudDatabaseRegistry;
  /** App-wide default version-history store (per-resource `versioningStore` overrides it). */
  versioningStore?: VersioningStore;
  /** App-wide default audit-log store (per-resource `auditStore` overrides it). */
  auditStore?: AuditStore;
}

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<CrudModuleOptions>({
  name: 'Crud',
  setup: ({ OPTIONS }) => ({
    providers: [
      CrudDatabaseRegistrations,
      defineProvider(CRUD_DATABASES, {
        useFactory: (options) => {
          if (!options.adapter && !options.databases)
            throw new ConfigurationException('CrudModule.forRoot requires adapter or databases');
          return options.databases?.forApplication();
        },
        inject: [OPTIONS],
      }),
      defineProvider(CRUD_DEFAULT_ADAPTER, {
        useFactory: (options) => {
          return options.adapter;
        },
        inject: [OPTIONS],
      }),
      // Optional app-wide default stores (may be undefined — resources that do
      // not enable versioning/audit never resolve them).
      defineProvider(CRUD_DEFAULT_VERSIONING_STORE, {
        useFactory: (options) => options.versioningStore,
        inject: [OPTIONS],
      }),
      defineProvider(CRUD_DEFAULT_AUDIT_STORE, {
        useFactory: (options) => options.auditStore,
        inject: [OPTIONS],
      }),
    ],
    exports: [
      CRUD_DATABASES,
      CRUD_DEFAULT_ADAPTER,
      CRUD_DEFAULT_VERSIONING_STORE,
      CRUD_DEFAULT_AUDIT_STORE,
    ],
  }),
});

// The definition each synthesized controller mounts, by controller class.
interface MountedFeature {
  readonly definition: CrudFeatureResource;
  readonly database: string | undefined;
  readonly path: string;
  readonly label: string;
}
const mountedFeatures = new WeakMap<Type, MountedFeature>();

class CrudDatabaseRegistrations {
  constructor(private readonly container: Container) {}
  onModuleInit(): void {
    if (this.container.getVisibleProviderSnapshots(CRUD_DATABASES).length > 1)
      throw new ConfigurationException(
        'Multiple CRUD database providers: choose one forRoot or forRequestAsync registration',
      );
  }
}
Injectable()(CrudDatabaseRegistrations);
Inject(Container)(CrudDatabaseRegistrations, undefined, 0);

// The routes a controller path mounts, however it is spelled: routes join the
// path without its trailing slash, a parameter segment matches whatever it is
// named, and repeated slashes (which proxies and clients commonly collapse)
// read as one. Routing is case-sensitive, so case is kept. Two paths with one
// canonical form mount the same routes.
function canonicalPath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/');
  const joined = (collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed) || '/';
  return joined.replace(/(^|\/):[^/]*/g, '$1:param');
}

/**
 * One definition per CRUD path in an application. Two `forFeature()`
 * registrations that mount one path with different definitions (other
 * decorators, hooks or policies) would both mount, and import order would
 * decide which one serves; the identical `defineCrudFeature()` value, imported
 * by several modules, is one policy. Paths compare in canonical form, so
 * spellings of one path (a trailing slash, repeated slashes, other parameter
 * names) are one path; routing is case-sensitive, so another case is not.
 */
class CrudFeaturePaths {
  readonly #discovery: DiscoveryService;
  constructor(
    discovery: DiscoveryService,
    private readonly container: Container,
  ) {
    this.#discovery = discovery;
  }
  onModuleInit(): void {
    const byPath = new Map<string, MountedFeature>();
    const byResource = new Map<string, MountedFeature>();
    const registrations = this.#discovery.getRegistrations({ metadataOnly: true, deferLazy: true });
    for (const { metatype } of registrations) {
      const mounted = mountedFeatures.get(metatype);
      if (!mounted) continue;
      const known = byPath.get(mounted.path);
      if (!known) {
        byPath.set(mounted.path, mounted);
      } else if (known.definition !== mounted.definition || known.database !== mounted.database) {
        throw new ConfigurationException(
          `CRUD path '${mounted.path}' is mounted by two different CrudModule.forFeature() ` +
            `features: ${known.label} and ${mounted.label}. Mount each path once, or import ` +
            'one shared defineCrudFeature(...) definition wherever it is registered.',
        );
      }
      const resourceKey = JSON.stringify([
        mounted.database,
        resourceNames(mounted.definition.config).singular,
      ]);
      const resource = byResource.get(resourceKey);
      const requestDatabase = this.container.getResolvedScope(CRUD_DATABASES) === Scope.REQUEST;
      if (
        (mounted.database !== undefined ||
          (requestDatabase && !mounted.definition.config.adapter)) &&
        resource &&
        resource.definition !== mounted.definition
      )
        throw new ConfigurationException(
          `Duplicate CRUD resource '${resourceNames(mounted.definition.config).singular}'`,
        );
      byResource.set(resourceKey, mounted);
      // Validate application-owned adapters eagerly without opening request databases.
      if (!requestDatabase) {
        const resolved = resolveCrudDatabaseSync(
          this.container,
          {
            ...mounted.definition.config,
            database: mounted.database,
          },
          { name: resourceNames(mounted.definition.config).singular, identity: mounted.definition },
        );
        compileResource(
          resourceNames(resolved).singular,
          toEngineConfig(resolved, resolved.adapter),
        );
      }
    }
  }
}
Injectable()(CrudFeaturePaths);
Inject(DiscoveryService)(CrudFeaturePaths, undefined, 0);
Inject(Container)(CrudFeaturePaths, undefined, 1);

export class CrudModule extends ConfigurableModuleClass {
  /** Acquire lazily in a managed HTTP/event scope. Consumers inherit request scope. */
  static forRequestAsync<const Inject extends readonly Token[] = readonly []>(
    options: {
      imports?: ModuleImport[];
      useFactory: (
        lifetime: ExecutionLifetime,
        ...dependencies: InferTokens<Inject>
      ) => CrudDatabaseLease | Promise<CrudDatabaseLease>;
    } & FactoryInject<Inject>,
  ): DynamicModule {
    if (options.inject === undefined && options.useFactory.length > 1)
      throw new ConfigurationException(
        'forRequestAsync factory dependencies require inject tokens',
      );
    // FactoryInject permits omission only for an empty dependency tuple.
    const inject = (options.inject ?? []) as Inject;
    return {
      module: CrudModule,
      key: `request-databases:${referenceKey(options)}`,
      imports: options.imports,
      providers: [
        CrudDatabaseRegistrations,
        defineProvider(CRUD_DATABASES, {
          scope: Scope.REQUEST,
          inject: [EXECUTION_LIFETIME, ...inject] as const,
          useFactory: async (lifetime, ...dependencies) => {
            if (!lifetime.active) throw new Error('Execution lifetime is closed');
            const lease = await options.useFactory(lifetime, ...dependencies);
            return lease.claim(lifetime);
          },
        }),
      ],
      exports: [CRUD_DATABASES],
    };
  }
  /**
   * Mounts headless resources. Controllers are synthesized (and their routes
   * stamped) synchronously here; the compiled engine resource is provided
   * under `crudResourceToken(name)` for anything that wants to dispatch verbs
   * programmatically.
   */
  static forFeature(
    features: CrudFeatureResource[],
    options: { database?: string } = {},
  ): DynamicModule {
    const resources = features.map((feature) => ({
      definition: feature,
      path: feature.path,
      config: { ...feature.config, database: feature.config.database ?? options.database },
    }));
    const identities = new Set<string>();
    for (const feature of resources) {
      const name = resourceNames(feature.config).singular;
      const key = JSON.stringify([feature.config.database, name]);
      if (identities.has(key))
        throw new ConfigurationException(`Duplicate CRUD resource '${name}'`);
      identities.add(key);
    }
    const controllers = resources.map((feature) => {
      const controller = synthesizeController(feature);
      const database = feature.config.database;
      const mounted = MetadataRegistry.getControllerPath(controller) || '/';
      const path = canonicalPath(mounted);
      mountedFeatures.set(controller, {
        definition: feature.definition,
        database,
        path,
        label:
          `'${resourceNames(feature.config).singular}' (${controller.name}` +
          `${database === undefined ? '' : `, database '${database}'`}` +
          `${mounted === path ? '' : `, as '${mounted}'`})`,
      });
      return controller;
    });
    const providers = resources.map((feature) => {
      const config = feature.config;
      const names = resourceNames(config);
      return defineProvider(crudResourceToken(names.singular, config.database), {
        scope: Scope.REQUEST,
        useFactory: async (container, moduleRef, lifetime) => {
          if (!lifetime.active) throw new Error('Execution lifetime is closed');
          const resolved = await resolveCrudDatabase(
            {
              has: container.has.bind(container),
              resolveAsync: (token) => moduleRef.resolve(token, undefined, { strict: false }),
            },
            config,
            {
              name: names.singular,
              identity: feature.definition,
            },
          );
          const resource = compileResource(
            names.singular,
            toEngineConfig(resolved, resolved.adapter),
          );
          return {
            ...resource,
            async execute(verb, request) {
              if (!lifetime.active) throw new Error('Execution lifetime is closed');
              return resource.execute(verb, request);
            },
          };
        },
        inject: [Container, ModuleRef, EXECUTION_LIFETIME],
      });
    });

    return {
      module: CrudModule,
      key: `feature:${resources.map((r) => JSON.stringify([r.config.database, r.path])).join(',')}`,
      controllers,
      providers: [...providers, CrudFeaturePaths],
      exports: resources.map((feature) =>
        crudResourceToken(resourceNames(feature.config).singular, feature.config.database),
      ),
    };
  }
}

export { MODULE_OPTIONS_TOKEN as CRUD_MODULE_OPTIONS };
