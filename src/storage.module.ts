import {
  defineModule,
  lazyProvider,
  stableHash,
  type DynamicModule,
  type InferTokens,
  type Token,
  type Type,
} from '@velajs/vela';
import { createStorageController, type ResolvedHttpOptions } from './storage.controller';
import { StorageService, type StorageServiceOptions } from './storage.service';
import { DEFAULT_STORAGE_NAME, storageDriverBuilder, storageToken } from './storage.tokens';
import type { StorageDriver, StorageHooks } from './storage.types';
import type { StorageAuthorizer } from './http/authorizer.types';

/** Options for mounting the HTTP upload/download controller for a bucket. */
export interface StorageHttpOptions {
  /** Mount path (relative to vela's globalPrefix). Default `/api/storage`. */
  basePath?: string;
  /** Fine-grained per-action authorizer (deny / allow / allow-with-overrides). */
  authorize?: StorageAuthorizer;
  /** Behavior when no `authorize` is set. Default `'deny'`. */
  defaultPolicy?: 'deny' | 'allow';
  /** `redirect` to a signed URL (default) or `proxy` bytes through the Worker. */
  download?: 'redirect' | 'proxy';
  /** Set `false` to configure options without mounting the controller. Default mounts. */
  mountController?: boolean;
  defaultExpiresIn?: number;
  maxExpiresIn?: number;
  maxUploadSize?: number;
  maxListLimit?: number;
  deleteConcurrency?: number;
}

export interface StorageModuleOptions {
  driver: StorageDriver;
  name?: string;
  prefix?: string;
  readonly?: boolean;
  hooks?: StorageHooks;
  http?: StorageHttpOptions;
}

export interface StorageModuleAsyncOptions<
  Inject extends readonly Token<unknown>[] = readonly Token<unknown>[],
> {
  inject?: Inject;
  imports?: DynamicModule['imports'];
  useFactory: (...deps: InferTokens<Inject>) => StorageDriver;
  name?: string;
  prefix?: string;
  readonly?: boolean;
  hooks?: StorageHooks;
  http?: StorageHttpOptions;
  key?: string;
}

/**
 * The internal, normalized options the module engine works with: the driver is
 * always a `() => StorageDriver` thunk so both `forRoot` (a built driver) and
 * `forRootAsync` (a deferred factory) flow through one options token and one
 * {@link lazyProvider}. The thunk is only *called* on first storage operation
 * (edge-binding safe), never at module load or service construction.
 */
interface StorageSetupOptions {
  driver: () => StorageDriver;
  name?: string;
  prefix?: string;
  readonly?: boolean;
  hooks?: StorageHooks;
  http?: StorageHttpOptions;
}

/**
 * The stable, identifying subset of the HTTP options folded into the instance
 * key — matches what `buildControllers` bakes into the mounted controller so
 * two registrations that differ only in HTTP behavior get distinct keys.
 */
function httpKeyPart(http: StorageHttpOptions | undefined): Record<string, unknown> {
  if (!http || http.mountController === false) return {};
  return {
    basePath: http.basePath ?? '/api/storage',
    download: http.download ?? 'redirect',
    defaultPolicy: http.defaultPolicy ?? 'deny',
  };
}

function buildControllers(
  name: string,
  serviceToken: Token<StorageService>,
  http: StorageHttpOptions | undefined,
): Type[] {
  if (!http || http.mountController === false) return [];
  const resolved: ResolvedHttpOptions = {
    driverName: name,
    authorize: http.authorize,
    defaultPolicy: http.defaultPolicy ?? 'deny',
    download: http.download ?? 'redirect',
    defaultExpiresIn: http.defaultExpiresIn ?? 900,
    maxExpiresIn: http.maxExpiresIn ?? 3600,
    maxUploadSize: http.maxUploadSize,
    maxListLimit: http.maxListLimit ?? 1000,
    deleteConcurrency: http.deleteConcurrency ?? 8,
  };
  const basePath = http.basePath ?? '/api/storage';
  return [createStorageController(basePath, serviceToken, resolved)];
}

const { ConfigurableModuleClass } = defineModule<StorageSetupOptions>({
  name: 'Storage',
  // Value-shaped identity only: never the (stateful) driver thunk. Same
  // name+prefix+readonly+hooks+http dedups (HMR-idempotent); a distinct bucket
  // name coexists.
  key: (o) =>
    stableHash({
      name: o.name ?? DEFAULT_STORAGE_NAME,
      prefix: o.prefix ?? '',
      readonly: !!o.readonly,
      hooks: !!o.hooks,
      ...httpKeyPart(o.http),
    }),
  setup: ({ OPTIONS, options }) => {
    const name = options.name ?? DEFAULT_STORAGE_NAME;
    const builderToken = storageDriverBuilder(name);
    const serviceToken = name === DEFAULT_STORAGE_NAME ? StorageService : storageToken(name);
    const svcOptions: StorageServiceOptions = {
      name,
      prefix: options.prefix,
      readonly: options.readonly,
      hooks: options.hooks,
    };
    return {
      providers: [
        // Deferred, memoized driver construction — the seam that keeps
        // Cloudflare bindings / `c.env` reads out of module load.
        lazyProvider({
          provide: builderToken,
          inject: [OPTIONS],
          useFactory: (o: StorageSetupOptions) => o.driver(),
        }),
        {
          provide: serviceToken,
          useFactory: (build: () => StorageDriver) => new StorageService(build, svcOptions),
          inject: [builderToken],
        },
      ],
      controllers: buildControllers(name, serviceToken, options.http),
      exports: [serviceToken, builderToken],
    };
  },
});

export class StorageModule {
  /** Synchronous registration — the driver is provided directly. */
  static forRoot(options: StorageModuleOptions): DynamicModule {
    const { driver, ...rest } = options;
    return {
      ...ConfigurableModuleClass.forRoot({ ...rest, driver: () => driver }),
      module: StorageModule,
    };
  }

  /** Deferred / DI-driven registration — `useFactory` runs lazily on first use. */
  static forRootAsync<const Inject extends readonly Token<unknown>[] = readonly Token<unknown>[]>(
    options: StorageModuleAsyncOptions<Inject>,
  ): DynamicModule {
    const { useFactory, inject, imports, key, ...structural } = options;
    return {
      ...ConfigurableModuleClass.forRootAsync<Inject>({
        imports,
        inject,
        key,
        ...structural,
        // Wrap the caller's driver factory in a thunk so resolving the options
        // token (at bootstrap) does NOT build the driver — only the first
        // storage operation does.
        useFactory: (...deps: InferTokens<Inject>) => ({ driver: () => useFactory(...deps) }),
      }),
      module: StorageModule,
    };
  }
}
