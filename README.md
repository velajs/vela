# @velajs/cloudflare-access

Zero Trust / OIDC identity verification for Vela: RS256-pinned JWKS verification, a fail-closed `resolveIdentity` contract with `composeResolvers` ordered fallback, a `defineIdentity` claim contract (declared type **and** runtime validator in one), and an optional Vela guard/module that bridges the verified identity into [`@velajs/authz`](https://www.npmjs.com/package/@velajs/authz). The core is **pure [`jose`](https://github.com/panva/jose) + Web APIs** — zero Cloudflare imports, edge-runtime safe (no `node:*`, no `Buffer`, no `process`).

## Why

An edge app in front of Cloudflare Access (or any OIDC issuer) has to answer one question on every request — *"who is this caller, and is the credential still valid?"* — identically across HTTP and WebSocket. This package is that single answer. It verifies the signed identity JWT **fail-closed** (a token that fails any check yields anonymous, never a partial identity) and shapes the result into a small structural `ResolvedIdentity` any framework hook can consume.

The four Cloudflare wire constants (the assertion header, the `/cdn-cgi/access/certs` JWKS path, the team-domain issuer, and the `CF_Authorization` cookie) are generalized behind an **issuer preset**, so the same package doubles as a generic OIDC/JWKS adapter.

## Install

```sh
pnpm add @velajs/cloudflare-access
# jose is the sole runtime dependency; @velajs/vela and @velajs/authz are
# optional peers, needed only for the `./vela` subpath.
```

## Quick start

```ts
import { cloudflareAccessIssuer, createAccessResolver } from '@velajs/cloudflare-access';

const resolveIdentity = createAccessResolver({
  preset: cloudflareAccessIssuer(env.CF_ACCESS_TEAM_DOMAIN), // e.g. "acme"
  aud: env.CF_ACCESS_AUD, // REQUIRED — the Access application audience tag
});

const identity = await resolveIdentity(request);
// identity: { userId, email?, groups?, exp?, claims, … } | null (anonymous)
```

## Core surface (`@velajs/cloudflare-access`)

### Issuer presets

Presets carry everything about *how the token rides the wire and what to pin against*.

- **`cloudflareAccessIssuer(teamDomain)`** — normalizes a short team name (`acme`), a host (`acme.cloudflareaccess.com`), or a full URL to the canonical `https://<host>` issuer (lowercased, no trailing slash, stray paths dropped via `URL`). Sets `jwksUri` to the `/cdn-cgi/access/certs` endpoint, pins `['RS256']`, reads the `cf-access-jwt-assertion` header with a `CF_Authorization` cookie fallback. Throws on an empty domain.
- **`genericOidcIssuer({ issuer, jwksUri?, algorithms?, header?, cookie?, bearer? })`** — any standards-compliant issuer. `jwksUri` defaults to `${issuer}/.well-known/jwks.json`, `algorithms` to `['RS256']`, and the token is read from `Authorization: Bearer <jwt>` by default (`bearer` strips the scheme). This is what makes the package a generic JWKS adapter.

### Verification

- **`verifyAccessJwt(token, { preset, aud, clockToleranceSec?, keySet? })`** — verifies in one shot and returns the claims, or throws (a `jose` error) on any failure. It pins the algorithm set to `preset.algorithms` (RS256 only by default, so an `alg:none` or HS-signed forgery is rejected outright), requires `iss === preset.issuer`, requires `aud` to include one of the configured audiences, and enforces a non-expired `exp`.
- **`aud` is REQUIRED and fail-closed.** `jose` only enforces the audience when a truthy value is passed, so an unset/empty `AUD` would silently accept a token minted for *another* application under the same issuer. This package refuses an empty audience (`normalizeAudiences` throws) rather than defaulting open.
- **`assertVerifyOptions(options)`** — eager config validation (issuer resolvable, JWKS URI parses, audience non-empty). `createAccessResolver` calls it at build time so a misconfigured deployment fails fast instead of degrading to silent-anonymous on every request.
- **`verifyRequest(request, options)`** — reads the token off the request (`readToken`) and verifies it; returns the claims or `undefined`. `onError(err, request)` observes a **present-but-invalid** token only (never an absent one), and a throw from the observer is swallowed so it can never break the fail-closed path.

### JWKS cache

`getRemoteJwks(jwksUri)` returns one `createRemoteJWKSet` getter **per issuer**, cached for the lifetime of the isolate. The getter holds the fetched keys with a built-in cooldown, refetches on an unknown `kid` (key rotation), and negative-caches a failed fetch during the cooldown — all internal to `jose`. Re-creating the getter per request would defeat every one of those, so a single instance per issuer is both correct and the recommended usage. The cache is **bounded** (`JWKS_CACHE_MAX = 32`, FIFO eviction) so an adversary hitting many issuer values cannot grow it without bound. `clearJwksCache()` and `jwksCacheSize()` are exported for tests.

### `defineIdentity` — one contract, type + validator

Declare the app's claim type **and** its runtime validation in a single declaration:

```ts
import { defineIdentity } from '@velajs/cloudflare-access';
import { z } from 'zod'; // any Standard Schema v1 validator works — no runtime dep here

const identity = defineIdentity({
  claims: z.object({ userId: z.string(), tenantId: z.string() }),
  onInvalid: 'reject', // or 'anonymous' (default)
});
```

The claim schema is a [Standard Schema v1](https://standardschema.dev) validator (zod 3.24+, valibot, arktype, …), so the core keeps its jose-only dependency footprint. The schema's validated output is constrained to extend `{ userId: string }` (or a custom `subjectClaim`), so a missing required subject is a **compile error**; at runtime `validate` runs the schema and then re-checks the subject is a non-empty string, so a schema that casts past the type still fails closed. `validate` only gates — it never rewrites the caller's claims, so undeclared claims are forwarded verbatim.

### Resolvers

- **`createAccessResolver({ preset, aud, mapClaims?, identity?, onError?, clockToleranceSec?, keySet? })`** — returns a fail-closed `ResolveIdentity`. Per request it verifies the token, optionally validates it against a `defineIdentity` contract (`onInvalid: 'anonymous'` downgrades a violation to `null`; `'reject'` throws a 401-shaped `IdentityRejectedError`), derives `userId` (`sub` → `email` → `common_name`), and maps to a `ResolvedIdentity` forwarding `email`, `commonName`, `groups`, `exp`, and the full `claims`. A missing or unverifiable token resolves to `null` (anonymous). `mapClaims` can add fields and override the derived `userId`.
- **`composeResolvers(...resolvers)`** — ordered fallback: each resolver is tried in order, the first non-null identity wins, and all-null resolves to anonymous (`null`). The sequential await is intentional.

### `ResolvedIdentity` and the WS socket-expiry contract

```ts
interface ResolvedIdentity {
  userId: string;
  exp?: number; // epoch SECONDS — drives WS socket expiry
  expiresAtMs?: number; // epoch MILLISECONDS — takes precedence over exp
  email?: string;
  commonName?: string;
  groups?: string[];
  claims: AccessClaims;
  [claim: string]: unknown;
}
```

`exp`/`expiresAtMs` are the **data contract** a WebSocket transport consumes to expire a socket when the credential lapses. This package (edge-neutral) only *produces* that value; the `./vela` guard writes it to a request-context key. The Durable-Object-side wiring that closes the socket at expiry lives in the Cloudflare adapter and is out of this package's scope.

## Vela integration (`@velajs/cloudflare-access/vela`)

The subpath ships the framework glue behind the optional `@velajs/vela` (and `@velajs/authz`) peers. Identity is handed off structurally — writes into the per-request `RequestContext` under `Symbol.for(...)` keys, so downstream code reads it by the same global symbol without importing this package.

- **`CloudflareAccessModule.forRoot(options)` / `.forRootAsync(options)`** — built on `defineModule`. Provides the `ResolveIdentity` (from `preset` + `aud` + optional contract) under the exported `ACCESS_RESOLVER` token, the guard, and the options bag. `forRootAsync` supports binding-time env config (`env.CF_ACCESS_TEAM_DOMAIN` / `AUD`). The resolver token is exported so an app can inject it and `composeResolvers(...)` it with other schemes.
- **`CloudflareAccessGuard`** — verifies via the configured resolver; on success writes the identity to `ACCESS_IDENTITY_KEY`, the expiry to `ACCESS_EXP_KEY`, and the `userId` to the Hono `userId` variable the CF WebSocket routing already forwards. `required` mode (default) rejects an anonymous caller with `UnauthorizedException`; `optional` mode passes them through. Fail-closed on every abnormal path.
- **`CurrentAccessIdentity()`** — parameter decorator yielding the verified identity for the request (or `undefined` when anonymous).
- **`identityFromAccess(identity)`** — bridges a `ResolvedIdentity` into an `@velajs/authz` `Identity` (`userId` → `userId`, `groups` → `roles`, full claims → `claims`). The `@velajs/authz` import is **type-only**, so no runtime dependency edge is added.
- **`AccessPermissionGuard` + `@RequireAccessPermission([...])`** — enforces `@velajs/authz` permissions (require-ALL / AND) against the mapped identity, resolving `AUTHZ` at **request time** from the container so it works whether or not `AuthzModule` is global. Fail-closed: denies when `AUTHZ` is unresolved, when no identity is present, or when any required permission is not granted.
- **Opt-in better-auth interop** — set `betterAuthInterop: true` to also project the identity as `{ id, role }` under `Symbol.for('vela.better-auth.user')`, so the unchanged `@velajs/better-auth` `PermissionGuard` can consume an Access caller. Off by default.

```ts
import { cloudflareAccessIssuer } from '@velajs/cloudflare-access';
import {
  CloudflareAccessGuard,
  CloudflareAccessModule,
  AccessPermissionGuard,
  RequireAccessPermission,
  CurrentAccessIdentity,
} from '@velajs/cloudflare-access/vela';

@Module({
  imports: [
    CloudflareAccessModule.forRoot({
      preset: cloudflareAccessIssuer(env.CF_ACCESS_TEAM_DOMAIN),
      aud: env.CF_ACCESS_AUD,
    }),
    AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] }),
  ],
  controllers: [PostsController],
})
class AppModule {}

@Controller('/posts')
@UseGuards(CloudflareAccessGuard, AccessPermissionGuard)
class PostsController {
  @Post()
  @RequireAccessPermission(['posts:write'])
  create(@CurrentAccessIdentity() identity: ResolvedIdentity) {
    return { author: identity.userId };
  }
}
```

## Security posture

- **Fail-closed everywhere.** Any verification failure (bad signature, wrong issuer/audience, expiry, unparseable token) yields anonymous, never a partial identity.
- **RS256-pinned.** The algorithm set is pinned per preset, so `alg:none` and HS-signed forgeries are rejected before any signature check.
- **Audience required.** An empty/unset `aud` is refused, never defaulted open.
- **No secrets in errors or logs.** Contract-violation messages never echo claim values; the package never logs.

## Testing without a network

The verification key source is injectable (`keySet`), so tests self-host a JWKS in-memory: generate an RS256 keypair with `jose`'s `generateKeyPair`, mint tokens with `SignJWT`, and build a local getter with `createLocalJWKSet` (or pass the public `CryptoKey` directly). No test touches the network.

## API

- Core: `verifyAccessJwt`, `verifyRequest`, `assertVerifyOptions`, `normalizeAudiences`, `readToken`, `cloudflareAccessIssuer`, `genericOidcIssuer`, `getRemoteJwks`, `clearJwksCache`, `jwksCacheSize`, `JWKS_CACHE_MAX`, `defineIdentity`, `createAccessResolver`, `composeResolvers`, `IdentityRejectedError`, and the `AccessClaims` / `IssuerPreset` / `ResolvedIdentity` / `ResolveIdentity` / `IdentityContract` / `StandardSchemaV1` types.
- `@velajs/cloudflare-access/vela`: `CloudflareAccessModule`, `CloudflareAccessGuard`, `AccessPermissionGuard`, `RequireAccessPermission`, `CurrentAccessIdentity`, `identityFromAccess`, and the `ACCESS_RESOLVER` / `ACCESS_IDENTITY_KEY` / `ACCESS_EXP_KEY` tokens.
