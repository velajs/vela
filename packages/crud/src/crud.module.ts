/**
 * `CrudModule` — defineModule-based (the queue-module template), EAGER by
 * design: adapter capability checks, tenant affirmations, and schema
 * derivation are load-time fail-fast wiring, exactly what docs/modules.md
 * says not to defer.
 *
 * - `forRoot({ adapter })` / `forRootAsync` provide the app-wide default
 *   adapter (`CRUD_DEFAULT_ADAPTER`).
 * - `forFeature([defineCrudFeature({ path, model, ... })])` synthesizes a controller per
 *   headless resource and registers its compiled engine under
 *   `crudResourceToken(name)` (options-derived providers, queue-style).
 */

import { Inject, Injectable, defineModule, defineProvider } from '@velajs/vela';
import { Container, DiscoveryService, MetadataRegistry } from '@velajs/vela/module-kit';
import type { DynamicModule, Type } from '@velajs/vela';
import type { CrudAdapter } from './adapter/contract';
import { ConfigurationException } from './envelope/errors';
import type { CrudDatabaseRegistry } from './databases';
import { missingDefaultAdapter } from './missing-adapter';
import { resolveCrudDatabase } from './resolve-database';
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
          return options.adapter ?? missingDefaultAdapter;
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
  constructor(discovery: DiscoveryService) {
    this.#discovery = discovery;
  }
  onModuleInit(): void {
    const byPath = new Map<string, MountedFeature>();
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
    }
  }
}
Injectable()(CrudFeaturePaths);
Inject(DiscoveryService)(CrudFeaturePaths, undefined, 0);

export class CrudModule extends ConfigurableModuleClass {
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
        useFactory: async (container) => {
          const resolved = await resolveCrudDatabase(container, config, {
            name: names.singular,
            identity: feature,
          });
          return compileResource(names.singular, toEngineConfig(resolved, resolved.adapter));
        },
        inject: [Container],
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
