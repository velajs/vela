import { InjectionToken } from '../container/types';

export const CONFIG_OPTIONS = new InjectionToken<Record<string, unknown>>('CONFIG_OPTIONS');

/**
 * Ambient environment record consumed by config-namespace factories
 * (`registerAs`). It is the multi-runtime substitute for stratal's
 * Cloudflare-specific `env` token: core never touches `process.env`.
 *
 * The token self-provides `{}` by default (so factories resolve even with no
 * platform binding), and stays OVERRIDABLE — a platform adapter
 * (`@velajs/cloudflare`) or a future `./config-node` subpath provides a global
 * `CONFIG_ENV` and that registration wins over the default.
 */
export const CONFIG_ENV = new InjectionToken<Record<string, unknown>>('CONFIG_ENV', {
  factory: () => ({}),
});
