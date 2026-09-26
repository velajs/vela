import {
  type ConfigurableModuleAsyncOptions,
  defineModule,
  defineProvider,
  type Token,
  type TypedToken,
  type Type,
  type VelaEnv,
} from '@velajs/vela';
import { Container, lazyProvider, readEnv, type EnvFactory } from '@velajs/vela/module-kit';
import { createStorageController, type ResolvedHttpOptions } from './storage.controller';
import { StorageService } from './storage.service';
import {
  DEFAULT_STORAGE_NAME,
  storageControllerOptions,
  storageDriverBuilder,
  storageToken,
} from './storage.tokens';
import type { StorageDriver, StorageHooks } from './storage.types';
import type { StorageAuthorizer } from './http/authorizer.types';
import { validateMultipartGrantSecret } from './http/multipart-grant';

/** Runtime policy for a bucket's HTTP upload/download controller. */
export interface StorageHttpOptions {
  /** Fine-grained per-action authorizer (deny / allow / allow-with-overrides). */
  authorize?: StorageAuthorizer;
  /** `redirect` to a signed URL (default) or `proxy` bytes through the Worker. */
  download?: 'redirect' | 'proxy';
  defaultExpiresIn?: number;
  maxExpiresIn?: number;
  maxUploadSize?: number;
  /**
   * HMAC key for stateless multipart grants, at least 32 bytes: a shorter one
   * fails application initialization. Required for multipart HTTP endpoints.
   */
  multipartGrantSecret?: string | Uint8Array;
  /** Maximum browser-direct multipart parts. Default 10,000. */
  maxMultipartParts?: number;
  maxListLimit?: number;
  deleteConcurrency?: number;
}

export interface StorageModuleOptions {
  /**
   * The bucket's driver, or a function that builds it from the application's
   * `ENV`. A function runs on the first storage operation (and again on the
   * next one until it succeeds), with the ENV of the application performing
   * it, so one static registration serves every environment and touches no
   * binding while the application initializes:
   * `driver: r2Storage({ binding: 'UPLOADS' })` from `@velajs/cloudflare/storage`,
   * or `driver: (env) => r2Driver({ bucket: env.UPLOADS })`.
   */
  driver: StorageDriver | EnvFactory<StorageDriver>;
  /** Bucket name; each name is its own `StorageService` token. Structural. */
  name?: string;
  prefix?: string;
  readonly?: boolean;
  hooks?: StorageHooks;
  /** Declare the HTTP routes. Omitted or false mounts no controller. Structural. */
  httpController?: { path?: string } | false;
  /** HTTP policy, including authorization and limits; resolved through DI. */
  http?: StorageHttpOptions;
}

/** The options `registerAsync` takes alongside its factory: they shape the module graph. */
export type StorageStructuralOption = 'name' | 'httpController';

/** Deferred registration; a driver factory without parameters may omit `inject`. */
export type StorageModuleAsyncOptions<Inject extends readonly Token[] = readonly Token[]> =
  ConfigurableModuleAsyncOptions<
    StorageModuleOptions,
    StorageStructuralOption,
    'create',
    Inject
  > & {
    isGlobal?: boolean;
  };

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`@velajs/storage: ${label} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

/** The driver itself, or the one its builder function returns from `env`, checked. */
function buildDriver(driver: StorageModuleOptions['driver'], env: VelaEnv): StorageDriver {
  const built: unknown = typeof driver === 'function' ? driver(env) : driver;
  if (
    typeof built !== 'object' ||
    built === null ||
    typeof Reflect.get(built, 'upload') !== 'function'
  ) {
    throw new TypeError(
      '@velajs/storage: `driver` must be a StorageDriver or a function that returns one',
    );
  }
  return built as StorageDriver;
}

function buildControllers(
  serviceToken: TypedToken<StorageService>,
  optionsToken: TypedToken<ResolvedHttpOptions>,
  controller: StorageModuleOptions['httpController'],
): Type[] {
  if (!controller) return [];
  return [createStorageController(controller.path ?? '/api/storage', serviceToken, optionsToken)];
}

function resolveHttpOptions(name: string, http: StorageHttpOptions = {}): ResolvedHttpOptions {
  if (http.multipartGrantSecret !== undefined) {
    validateMultipartGrantSecret(http.multipartGrantSecret);
  }
  const defaultExpiresIn = positiveInteger(http.defaultExpiresIn ?? 900, 'defaultExpiresIn');
  const maxExpiresIn = positiveInteger(http.maxExpiresIn ?? 3600, 'maxExpiresIn');
  return {
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
}

const { ConfigurableModuleClass } = defineModule<
  StorageModuleOptions,
  StorageStructuralOption,
  { isGlobal?: boolean },
  'register'
>({
  name: 'Storage',
  methodName: 'register',
  structural: ['name', 'httpController'],
  defaults: { name: DEFAULT_STORAGE_NAME },
  // One instance per bucket name: the name decides the provided tokens, so a
  // second registration of a name with different options fails bootstrap
  // rather than serving one bucket through the other's routes. Never keyed by
  // a secret.
  key: (options) => options.name ?? DEFAULT_STORAGE_NAME,
  setup: ({ OPTIONS, options }) => {
    const name = options.name ?? DEFAULT_STORAGE_NAME;
    const builderToken = storageDriverBuilder(name);
    const serviceToken = name === DEFAULT_STORAGE_NAME ? StorageService : storageToken(name);
    const controllerOptions = storageControllerOptions(name);
    return {
      providers: [
        // Deferred, memoized driver construction — the seam that keeps
        // Cloudflare bindings out of module load and application bootstrap.
        lazyProvider({
          provide: builderToken,
          inject: [OPTIONS, Container],
          useFactory: (resolved: StorageModuleOptions, container: Container) =>
            buildDriver(resolved.driver, readEnv(container)),
        }),
        defineProvider(serviceToken, {
          useFactory: (build, resolved, container) => {
            if (container.getOwnerModuleIds(serviceToken).length !== 1) {
              throw new TypeError(
                `@velajs/storage: duplicate bucket registration '${name}'; reuse the same module import`,
              );
            }
            return new StorageService(build, {
              name,
              prefix: resolved.prefix,
              readonly: resolved.readonly,
              hooks: resolved.hooks,
            });
          },
          inject: [builderToken, OPTIONS, Container],
        }),
        defineProvider(controllerOptions, {
          useFactory: (resolved) => resolveHttpOptions(name, resolved.http),
          inject: [OPTIONS],
        }),
      ],
      controllers: buildControllers(serviceToken, controllerOptions, options.httpController),
      exports: [serviceToken, builderToken],
    };
  },
});

/**
 * Registers one storage bucket: its `StorageService` (the default bucket) or
 * `storageToken(name)` service, and optionally the HTTP controller.
 *
 * `name` and `httpController` are structural: `registerAsync` takes them alongside
 * its factory, which returns the driver, HTTP policy and other runtime options.
 */
export class StorageModule extends ConfigurableModuleClass {}
