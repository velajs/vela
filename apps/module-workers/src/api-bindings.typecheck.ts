import type { CatalogBinding } from './native-contracts';

// Check the independent caller contract against Wrangler's actual native stubs.
const catalog = (env: Cloudflare.Env): CatalogBinding => env.NATIVE_CATALOG;
const untrusted = (env: Cloudflare.Env): CatalogBinding => env.UNTRUSTED_CATALOG;
void [catalog, untrusted];
