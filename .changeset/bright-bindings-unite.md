---
'@velajs/cli': minor
'@velajs/cloudflare': minor
---

Unify Wrangler binding discovery across resource addition, configuration sync and deployment checks. Cover current native binding shapes, detect cross-kind name collisions, respect environment inheritance exceptions, and preserve unknown configuration. Known malformed bindings now fail before resource creation or config edits.

Add `vela add binding <kind> <BINDING> --options <JSON>` for native JSON/JSONC declarations without provisioning resources or adding modules. Selected-environment type generation now calls Wrangler with `--env` instead of running an unqualified types script.

Expose `flagship({ binding })` and `secretsStoreSecret({ binding })` native references from `@velajs/cloudflare`, resolving the original handle separately for each environment without caching values.
