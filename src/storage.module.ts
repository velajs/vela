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
  /** @deprecated Storage HTTP routes are deny-only without `authorize`. */
  defaultPolicy?: 'deny';
  /** `redirect` to a signed URL (default) or `proxy` bytes through the Worker. */
  download?: 'redirect' | 'proxy';
  /** Set `false` to configure options without mounting the controller. Default mounts. */
  mountController?: boolean;
  defaultExpiresIn?: number;
  maxExpiresIn?: number;
  maxUploadSize?: number;
  /** HMAC key for stateless multipart grants. Required for multipart HTTP endpoints. */
  multipartGrantSecret?: string | Uint8Array;
  /** Maximum browser-direct multipart parts. Default 10,000. */
  maxMultipartParts?: number;
  maxListLimit?: number;
  deleteConcurrency?: number;
}

export interface StorageModuleOptions {
  driver: StorageDriver;
  /** Optional caller namespace; it is combined with, never substituted for, instance identity. */
  key?: string;
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
  /** Optional caller namespace; it is combined with, never substituted for, factory identity. */
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
  registrationIdentity: string;
  name?: string;
  prefix?: string;
  readonly?: boolean;
  hooks?: StorageHooks;
  http?: StorageHttpOptions;
}

const objectIdentities = new WeakMap<object, number>();
const symbolIdentities = new Map<symbol, number>();
const stringIdentities = new Map<string, number>();
let nextIdentity = 1;

/** Process-local identity avoids source-code and presence-only collisions for stateful options. */
function instanceIdentity(value: unknown): string {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    const key = value as object;
    let id = objectIdentities.get(key);
    if (id === undefined) {
      id = nextIdentity++;
      objectIdentities.set(key, id);
    }
    return `object:${id}`;
  }
  if (typeof value === 'symbol') {
    let id = symbolIdentities.get(value);
    if (id === undefined) {
      id = nextIdentity++;
      symbolIdentities.set(value, id);
    }
    return `symbol:${id}`;
  }
  return `${typeof value}:${String(value)}`;
}

function secretIdentity(value: string | Uint8Array | undefined): string {
  if (value === undefined) return 'none';
  if (value instanceof Uint8Array) return instanceIdentity(value);
  let id = stringIdentities.get(value);
  if (id === undefined) {
    id = nextIdentity++;
    stringIdentities.set(value, id);
  }
  return `secret:${id}`;
}

function securityIdentity(input: {
  owner: unknown;
  callerKey?: string;
  hooks?: StorageHooks;
  http?: StorageHttpOptions;
  inject?: readonly unknown[];
  imports?: readonly unknown[];
}): string {
  return stableHash({
    owner: instanceIdentity(input.owner),
    callerKey: input.callerKey ?? null,
    hooks: input.hooks ? instanceIdentity(input.hooks) : null,
    authorize: input.http?.authorize ? instanceIdentity(input.http.authorize) : null,
    multipartGrantSecret: secretIdentity(input.http?.multipartGrantSecret),
    inject: input.inject?.map(instanceIdentity) ?? [],
    imports: input.imports?.map(instanceIdentity) ?? [],
  });
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
    defaultExpiresIn: http.defaultExpiresIn ?? 900,
    maxExpiresIn: http.maxExpiresIn ?? 3600,
    maxUploadSize: http.maxUploadSize ?? null,
    maxListLimit: http.maxListLimit ?? 1000,
    deleteConcurrency: http.deleteConcurrency ?? 8,
    maxMultipartParts: http.maxMultipartParts ?? 10_000,
    multipartGrants: http.multipartGrantSecret !== undefined,
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`@velajs/storage: ${label} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

function buildControllers(
  name: string,
  serviceToken: Token<StorageService>,
  http: StorageHttpOptions | undefined,
): Type[] {
  if (!http || http.mountController === false) return [];
  if (http.defaultPolicy !== undefined && http.defaultPolicy !== 'deny') {
    throw new TypeError(
      '@velajs/storage: defaultPolicy is deny-only; use an explicit authorize callback for public access',
    );
  }
  const defaultExpiresIn = positiveInteger(http.defaultExpiresIn ?? 900, 'defaultExpiresIn');
  const maxExpiresIn = positiveInteger(http.maxExpiresIn ?? 3600, 'maxExpiresIn');
  const resolved: ResolvedHttpOptions = {
    driverName: name,
    authorize: http.authorize,
    download: http.download ?? 'redirect',
    defaultExpiresIn,
    maxExpiresIn,
    maxUploadSize: optionalPositiveInteger(http.maxUploadSize, 'maxUploadSize'),
    multipartGrantSecret: http.multipartGrantSecret,
    maxMultipartParts: positiveInteger(http.maxMultipartParts ?? 10_000, 'maxMultipartParts'),
    maxListLimit: positiveInteger(http.maxListLimit ?? 1000, 'maxListLimit'),
    deleteConcurrency: positiveInteger(http.deleteConcurrency ?? 8, 'deleteConcurrency'),
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
      registrationIdentity: o.registrationIdentity,
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
    const { driver, key, ...rest } = options;
    const registrationIdentity = securityIdentity({
      owner: driver,
      callerKey: key,
      hooks: rest.hooks,
      http: rest.http,
    });
    return {
      ...ConfigurableModuleClass.forRoot({
        ...rest,
        registrationIdentity,
        driver: () => driver,
      }),
      module: StorageModule,
    };
  }

  /** Deferred / DI-driven registration — `useFactory` runs lazily on first use. */
  static forRootAsync<const Inject extends readonly Token<unknown>[] = readonly Token<unknown>[]>(
    options: StorageModuleAsyncOptions<Inject>,
  ): DynamicModule {
    const { useFactory, inject, imports, key, ...structural } = options;
    const registrationIdentity = securityIdentity({
      owner: useFactory,
      callerKey: key,
      hooks: structural.hooks,
      http: structural.http,
      inject,
      imports,
    });
    const asyncStructural = { ...structural, registrationIdentity };
    return {
      ...ConfigurableModuleClass.forRootAsync<Inject>({
        imports,
        inject,
        ...asyncStructural,
        // Wrap the caller's driver factory in a thunk so resolving the options
        // token (at bootstrap) does NOT build the driver — only the first
        // storage operation does.
        useFactory: (...deps: InferTokens<Inject>) => ({
          registrationIdentity,
          driver: () => useFactory(...deps),
        }),
      }),
      module: StorageModule,
    };
  }
}
