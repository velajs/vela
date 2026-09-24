import {
  type ConfigurableModuleAsyncOptions,
  defineModule,
  defineProvider,
  type Token,
  type TypedToken,
  type Type,
} from '@velajs/vela';
import { lazyProvider } from '@velajs/vela/module-kit';
import {
  createStorageController,
  type ResolvedHttpOptions,
  type StorageControllerOptions,
} from './storage.controller';
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

/** Options for mounting the HTTP upload/download controller for a bucket. */
export interface StorageHttpOptions {
  /** Mount path (relative to vela's globalPrefix). Default `/api/storage`. */
  basePath?: string;
  /** Fine-grained per-action authorizer (deny / allow / allow-with-overrides). */
  authorize?: StorageAuthorizer;
  /** `redirect` to a signed URL (default) or `proxy` bytes through the Worker. */
  download?: 'redirect' | 'proxy';
  /** Set `false` to configure options without mounting the controller. Default mounts. */
  mountController?: boolean;
  defaultExpiresIn?: number;
  maxExpiresIn?: number;
  maxUploadSize?: number;
  /**
   * HMAC key for stateless multipart grants, at least 32 bytes: a shorter one
   * throws when the module is set up. Required for multipart HTTP endpoints,
   * unless the top-level `multipartGrantSecret` option supplies it.
   */
  multipartGrantSecret?: string | Uint8Array;
  /** Maximum browser-direct multipart parts. Default 10,000. */
  maxMultipartParts?: number;
  maxListLimit?: number;
  deleteConcurrency?: number;
}

export interface StorageModuleOptions {
  /**
   * The bucket's driver, or a function that builds it. A function runs on the
   * first storage operation (and again on the next one until it succeeds), so
   * a `forRootAsync` factory can return `{ driver: () => r2Driver(...) }`
   * without touching a binding while the application initializes.
   */
  driver: StorageDriver | (() => StorageDriver);
  /** Bucket name; each name is its own `StorageService` token. Structural. */
  name?: string;
  prefix?: string;
  readonly?: boolean;
  hooks?: StorageHooks;
  /** The HTTP controller. Structural: it decides the mounted routes. */
  http?: StorageHttpOptions;
  /**
   * HMAC key for stateless multipart grants, at least 32 bytes, such as a
   * secret a `forRootAsync` factory reads from `ENV`. Takes precedence over
   * `http.multipartGrantSecret`; a shorter one fails every multipart grant.
   */
  multipartGrantSecret?: string | Uint8Array;
}

/** The options `forRootAsync` takes alongside its factory: they shape the module graph. */
export type StorageStructuralOption = 'name' | 'http';

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

/** The driver itself, or the one its builder function returns, checked. */
function buildDriver(driver: StorageModuleOptions['driver']): StorageDriver {
  const built: unknown = typeof driver === 'function' ? driver() : driver;
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
  name: string,
  serviceToken: TypedToken<StorageService>,
  optionsToken: TypedToken<StorageControllerOptions>,
  http: StorageHttpOptions | undefined,
): Type[] {
  if (!http || http.mountController === false) return [];
  if (http.multipartGrantSecret !== undefined) {
    validateMultipartGrantSecret(http.multipartGrantSecret);
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
  return [createStorageController(basePath, serviceToken, resolved, optionsToken)];
}

const { ConfigurableModuleClass } = defineModule<StorageModuleOptions, StorageStructuralOption>({
  name: 'Storage',
  structural: ['name', 'http'],
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
          inject: [OPTIONS],
          useFactory: (resolved: StorageModuleOptions) => buildDriver(resolved.driver),
        }),
        defineProvider(serviceToken, {
          useFactory: (build, resolved) =>
            new StorageService(build, {
              name,
              prefix: resolved.prefix,
              readonly: resolved.readonly,
              hooks: resolved.hooks,
            }),
          inject: [builderToken, OPTIONS],
        }),
        defineProvider(controllerOptions, {
          useFactory: (resolved) => ({ multipartGrantSecret: () => resolved.multipartGrantSecret }),
          inject: [OPTIONS],
        }),
      ],
      controllers: buildControllers(name, serviceToken, controllerOptions, options.http),
      exports: [serviceToken, builderToken],
    };
  },
});

/**
 * Registers one storage bucket: its `StorageService` (the default bucket) or
 * `storageToken(name)` service, and optionally the HTTP controller.
 *
 * `name` and `http` are structural: `forRootAsync` takes them alongside its
 * factory, which returns the driver and the other options.
 */
export class StorageModule extends ConfigurableModuleClass {}
