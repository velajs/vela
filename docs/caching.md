# Caching and scoped invalidation

`CacheModule` from `@velajs/vela/cache` is the one cache module, asynchronous
end to end. Its `store` is any `CacheStore`, synchronous or asynchronous:
`MemoryCacheStore` (the default, one per application), `TieredCacheStore`, or
`kvCache({ binding })` from `@velajs/cloudflare` on Workers. One configured
store serves both `@CacheResponse()` routes and the injected `CacheService`.
`namespace` and a trusted `scope` resolver are required.

## Configure an explicit scope

```ts
import { Controller, Get, Module } from '@velajs/vela';
import {
  CacheModule,
  CacheResponse,
  MemoryCacheInvalidationStore,
} from '@velajs/vela/cache';

@Controller('/catalog')
class CatalogController {
  @Get()
  @CacheResponse({ ttl: 30, tags: ['catalog'] })
  list() { return { items: [] }; }
}

@Module({
  imports: [CacheModule.forRoot({
    namespace: 'catalog-v1',
    // A function builds one generation store per application.
    invalidation: () => new MemoryCacheInvalidationStore(),
    scope: () => ({ visibility: 'public', partition: 'catalog' }),
  })],
  controllers: [CatalogController],
})
class AppModule {}
```

Configure one `CacheModule` per application, with `forRoot` or `forRootAsync`.
Without `store`, each application gets its own `MemoryCacheStore` of `max`
entries (default 1000). A store or invalidation object in static options is
shared by every application built from the module; pass a function to build one
per application instead. The module registers its interceptor automatically, but only decorated GET
routes participate. Guards run on **every request**, including hits. The scope
resolver receives `ExecutionContext` after authorization. For authenticated
routes, return `{ visibility: 'private', partition: JSON.stringify([tenantId,
actorId, permissionVersion]) }` using identifiers established by your guard or
trusted request context. Include every dimension that changes the representation,
such as locale. Never derive a partition from an unverified tenant header,
bearer token or session cookie. Tenant-wide sharing is appropriate only when all
authorized actors really receive the same output. Scope selection does not
perform authorization itself.

Returning `undefined`, throwing, or returning an invalid scope bypasses caching.
A public scope always bypasses requests containing Authorization or Cookie, or
a published trusted request identity.
Applications authenticating through another mechanism must select private scopes
explicitly. Namespace, visibility, partition, origin, path, canonical query, and
optional decorator `key` are hashed with unambiguous boundaries. A custom key
cannot replace the route or partition. Programmatic values have a separate key
space; their tags and whole-scope invalidation still reach routes in that scope.
Change `namespace` when deploying an incompatible response schema or cache policy.

`ttl` is seconds, default 30; zero bypasses caching. Labels/partitions are nonempty
strings of at most 2048 UTF-8 bytes; at most 32 tags are allowed per entry. Invalid
module options fail when its service is constructed. Invalid decorator options
fail when declared. Tags require an invalidation store; a tagged route without
one fails at application bootstrap, as do multiple `CacheModule` instances.

## Custom services and post-commit invalidation

```ts
const scoped = cache.scope({ visibility: 'private', partition: trustedPartition });
await scoped.set('summary', { count: 3 }, { ttl: 30, tags: ['summaries'] });
const summary = await scoped.getParsed('summary', parseSummary);

// Authorize first. Do not invalidate on failed or rolled-back writes.
const result = await repository.commitUpdate(input);
const invalidation = await scoped.invalidateTags(['summaries']);
if (!invalidation.ok) recordInvalidationFailure(invalidation.reason);
return result;
```

Here `cache` is an injected `CacheService`. `get` returns unknown;
`getParsed` validates through the supplied parser (parser errors propagate).
`remember(key, asyncLoader, options)` reads through the same store. Its result is
unknown because stored values require validation; validate it before domain use.
Concurrent misses execute separate loaders and do not share request response
state. `set` resolves to a boolean indicating whether the cache accepted the
value. `invalidateKey` targets a programmatic key; `invalidateTags` targets the
same labels across programmatic values and routes; `invalidateAll` invalidates
only the selected namespace/visibility/partition. There is no unscoped service
clear or cross-partition tag invalidation. For several known authorized scopes,
explicitly invalidate each scope after the write commits.

CRUD integrations can invoke the same methods in a successful post-commit hook.
The cache core has no dependency on CRUD, transactions, or domain entities. An
invalidation failure resolves `{ ok: false, reason: 'store-error' }`; missing
capability yields `unsupported`, invalid labels yield `invalid-input`. Success
is `{ ok: true }`. Await/record these outcomes; do not throw a write failure after
commit. Failed invalidation can leave old entries readable until TTL expires.
Applications needing retries should enqueue their own durable post-commit work.

## Replay and failure boundaries

Only bounded JSON values are stored: by default at most 64 KiB (configurable
`maxBytes`, hard maximum 1 MiB), 32 levels and 10,000 visited values. Cached hits
are independent JSON snapshots. Streams, `Response` objects, class instances,
accessors, cycles, nonfinite numbers and function-bearing objects are bypassed.
Cookie-setting output, `Cache-Control: private/no-store`, declared redirects and
non-200 responses are bypassed. This includes response-header decorators.
The cache stores handler values, not response headers; routes must not depend on
per-request header side effects in a skipped handler. Middleware wrapping the
pipeline still runs and must keep cookie/session work outside cacheable handlers.

Never cache passwords, credentials, session secrets or other private
authentication material, even in a private partition. Common secret field names
are rejected defensively; no generic cache can recognize every application
secret. Use `shouldCache(value)` for an additional domain allowlist, or omit
`@CacheResponse` entirely from sensitive routes. The same checks run on reads.

Store or generation-read failure means a miss; a read failure bypasses filling
for that request. Cache write failure returns the original handler result. Loader
errors propagate. Each absorbed failure goes to the application's error reporter
with edge `'cache'` and the operation (`read`, `write`, `invalidate` or `scope`)
as its source, so an unreachable store or a missing KV binding is logged, or
reaches an `ExceptionHandler`, instead of silently disabling the cache. An
optional `onError(operation, error)` callback then receives it too; exceptions
from this callback are ignored. No cache key, partition or payload is added to
either. Store error objects may contain vendor details, so redact them before
external logging.

## Expiry, concurrency, and distributed stores

`CacheInvalidationStore` is an optional generation capability separate from value
storage: `getVersion(key)` returns a nonempty version string and `invalidate(key)`
changes it to a version that must never be reused. No tag enumeration or
read-modify-write membership list is needed. Each response entry records its
scope/key/tag generations and absolute expiry. Reads recheck generations and
expiry; fills capture generations **before** running their loader. With consistently observed generations, a fill that started before invalidation
cannot become a valid cached hit afterward, even if its physical write finishes
late. An eventually consistent store can still return an older generation. The in-flight request itself may still
return its original result. Late writes can replace newer entries with invalid
ones, causing a miss, rather than replaying stale values.

`MemoryCacheInvalidationStore` is bounded and process-local. Evicted markers get
fresh versions; eviction causes misses, never a return to an earlier generation.
Share its instance only among caches intended to invalidate one another. It does
not coordinate different processes or isolates.

`TieredCacheStore` preserves expiry when promoting entries. Sources need the
optional `CacheEntryReader.getEntry`; destinations need
`CacheEntryWriter.setEntry` to accept an absolute deadline. The built-in memory,
tiered and KV stores implement these capabilities. Values from legacy stores
with unknown expiry remain readable but are not backfilled. Writes/deletes/clears
attempt every tier and reject on failure. Mutations and backfills through a single
tiered instance are ordered; bypassing it with direct tier writes is outside that
fence. No tier can extend the response envelope's logical deadline.

On Workers, name the KV namespaces instead of holding them. `kvCache` and
`kvCacheInvalidation` from `@velajs/cloudflare` read each application's `ENV`
when an operation needs the namespace, so one static registration serves every
environment. A binding missing from `ENV` fails that operation with an error
naming the binding and `kv_namespaces`, which the cache reports as above:

```ts
import { CacheModule } from '@velajs/vela/cache';
import { kvCache, kvCacheInvalidation } from '@velajs/cloudflare';

CacheModule.forRoot({
  namespace: 'catalog-v1',
  store: kvCache({ binding: 'CACHE_VALUES' }),
  invalidation: kvCacheInvalidation({ binding: 'CACHE_GENERATIONS' }),
  scope: trustedCacheScope,
  ttl: 30,
});
```

`store` and `invalidation` also take a function of `ENV`, which builds them per
application; use it to compose tiers. `kvCache({ binding })` is itself such a
function, so a tier still names its namespace instead of reading `ENV` directly:

```ts
import { CacheModule, MemoryCacheStore, TieredCacheStore } from '@velajs/vela/cache';
import { kvCache, kvCacheInvalidation } from '@velajs/cloudflare';

const values = kvCache({ binding: 'CACHE_VALUES' });

CacheModule.forRoot({
  namespace: 'catalog-v1',
  store: (env) => new TieredCacheStore([new MemoryCacheStore(), values(env)]),
  invalidation: kvCacheInvalidation({ binding: 'CACHE_GENERATIONS' }),
  scope: trustedCacheScope,
});
```

`KVCacheStore`, `KVCacheInvalidationStore`, `kvCache` and `kvCacheInvalidation`
come from `@velajs/cloudflare`. The value adapter records logical expiry in metadata, so KV's minimum 60-second
physical retention does not extend a shorter cache TTL. Legacy KV values without
expiry metadata stay readable but are not promoted. Use a **separate dedicated
namespace** for generations, without expiration or lifecycle deletion. Never
clear/recreate generation markers while corresponding values or fills survive.

KV invalidation is **eventually consistent**: stale and negative reads, concurrent
writes, last-writer-wins ordering, and KV's per-key write limits can delay or lose
the visibility of an invalidation. `{ ok: true }` means the store accepted the
operation; it does not promise globally fresh reads. L1 hits still check the
configured generation store. Do not use KV caching for authorization revocation
or workflows that require strong read-after-write behavior. Choose a coordinated
invalidation store with the required guarantees or disable caching. See
[Cloudflare's consistency guidance](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
and [write limits](https://developers.cloudflare.com/kv/api/write-key-value-pairs/).
