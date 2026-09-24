import { Inject } from './container/decorators';
import { InjectionToken } from './container/types';

/**
 * The environment a runtime hands the application: bindings, variables and
 * secrets. Core declares it empty and never reads a platform global; a runtime
 * package augments it through declaration merging. `@velajs/cloudflare`
 * extends it with `Cloudflare.Env`, which `wrangler types` generates:
 *
 * ```ts
 * declare module '@velajs/vela' {
 *   interface VelaEnv extends Cloudflare.Env {}
 * }
 * ```
 *
 * Values arrive from outside the program, so readers still validate them
 * before assigning a domain type.
 */
export interface VelaEnv {}

/**
 * The runtime environment of one application, as a global token. It has no
 * default: a runtime seeds it per application (`VelaFactory.create(root, { env })`,
 * a {@link RuntimeAdapter}'s `configureContainer`, or `@velajs/cloudflare`),
 * and a required read without one fails. Framework readers inject it with
 * `@Optional()` and validate each value they use.
 */
export const ENV = /* @__PURE__ */ new InjectionToken<VelaEnv>('ENV');

/** Inject the application's {@link ENV}: `constructor(@InjectEnv() env: VelaEnv)`. */
export function InjectEnv(): ParameterDecorator {
  return Inject(ENV);
}

/** Validate a runtime environment before it is seeded as {@link ENV}. */
export function assertEnvironment(env: unknown): asserts env is VelaEnv {
  if (typeof env !== 'object' || env === null) {
    throw new TypeError('The runtime environment must be an object of bindings and variables.');
  }
}

/** Read one string variable or secret from an environment; any other value is ignored. */
export function readEnvString(env: VelaEnv | undefined, key: string): string | undefined {
  if (typeof env !== 'object' || env === null) return undefined;
  const value: unknown = Reflect.get(env, key);
  return typeof value === 'string' ? value : undefined;
}
