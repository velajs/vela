import { BindingRef } from './binding-ref';

// Sentinel binding name for the whole-env holder — never used as an env key.
const ENV_SENTINEL = '__cf_env__';

/**
 * Holds the entire Cloudflare Worker `env` record (bindings + vars/secrets),
 * not a single binding. Subclasses {@link BindingRef} so createCloudflareApp's
 * binding-init middleware collects and initializes it through the same path;
 * the factory special-cases it to pass the full `env` instead of one binding.
 */
export class EnvRef extends BindingRef<Record<string, unknown>> {
  constructor() {
    super(ENV_SENTINEL);
  }
}
