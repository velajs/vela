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
// identity: { issuer, subject, principalType, expiresAtMs, ... } | null
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

- **`createAccessResolver({ preset, aud, mapClaims?, groupRoles?, identity?, onError?, clockToleranceSec?, keySet? })`** — returns a fail-closed `ResolveIdentity`. It requires a finite `exp`, derives stable `{ issuer, subject, principalType }`, exposes the verified expiry only as epoch-millisecond `expiresAtMs`, and retains `userId` as a compatibility alias for `subject`. `mapClaims` may add application fields but cannot replace verified identity, expiry, groups, claims, or local roles.
- **External groups are not roles.** `groupRoles` is an explicit own-property allowlist such as `{ 'idp-editors': ['editor'] }`; unmapped groups grant nothing.
- **`composeResolvers(...resolvers)`** — ordered fallback: each resolver is tried in order, the first non-null identity wins, and all-null resolves to anonymous (`null`). The sequential await is intentional.

### `ResolvedIdentity` and the WS socket-expiry contract

```ts
interface ResolvedIdentity {
  issuer: string;
  subject: string;
  principalType: 'user' | 'service';
  /** @deprecated compatibility alias for subject */
  userId: string;
  expiresAtMs: number;
  email?: string;
  commonName?: string;
  groups?: string[];
  roles?: string[]; // only from explicit groupRoles mapping
  claims: AccessClaims;
  [claim: string]: unknown;
}
```

`expiresAtMs` is the **data contract** a WebSocket transport consumes to expire a socket when the credential lapses. The JWT `exp` remains in `claims` in its standard epoch-seconds form; it is never exposed as a competing top-level unit.

## Vela integration (`@velajs/cloudflare-access/vela`)

The guard publishes through core's `setTrustedRequestIdentity`. Authorization, `@CurrentIdentity()`, throttling, and WebSocket upgrade checks all consume this canonical state.

- `CloudflareAccessModule.forRoot(options)` / `.forRootAsync(options)` provide the verified resolver, guard, and options. Async registration constructs the resolver from resolved injected options.
- `CloudflareAccessGuard` clears prior identity before verification. Required mode rejects anonymous callers; optional mode passes them through with no identity. Invalid, expired, or throwing credentials cannot retain an old identity.
- Import `PermissionGuard`, `RequirePermission`, `RolesGuard`, `Roles`, and `CurrentIdentity` from `@velajs/authz/vela`. These are the same guards Better Auth uses. Exactly one authorization engine must be visible to the declaring route module.
- Tenant membership comes from a signed `tenantId` claim, or the signed claim selected by `tenantClaim`. `mapClaims` enriches non-authority fields only and cannot replace tenant, issuer, subject, expiry, claims, or roles. Explicit `groupRoles` maps external groups into local roles.
- `identityFromAccess` is a pure projection for direct authz use; it does not authenticate a request.
- `CloudflareAccessUpgradeAuthenticator` authenticates WebSocket upgrades: `@WebSocketGateway({ authenticator: CloudflareAccessUpgradeAuthenticator })`. It is resolved from the module that declares the gateway, which must import `CloudflareAccessModule`, and verifies with the same resolver as the guard. Upgrades always need a verified identity, whatever the module `mode`, and a token without the signed tenant claim is refused.

```ts
import { cloudflareAccessIssuer } from '@velajs/cloudflare-access';
import {
  CloudflareAccessGuard,
  CloudflareAccessModule,
} from '@velajs/cloudflare-access/vela';
import { AuthzModule, PermissionGuard, RequirePermission, CurrentIdentity } from '@velajs/authz/vela';
import type { TrustedRequestIdentity } from '@velajs/vela';

@Module({
  imports: [
    CloudflareAccessModule.forRoot({
      preset: cloudflareAccessIssuer(env.CF_ACCESS_TEAM_DOMAIN),
      aud: env.CF_ACCESS_AUD,
      groupRoles: { 'idp-editors': ['editor'] },
    }),
    AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] }),
  ],
  controllers: [PostsController],
})
class AppModule {}

@Controller('/posts')
@UseGuards(CloudflareAccessGuard, PermissionGuard)
class PostsController {
  @Post()
  @RequirePermission(['posts:write'])
  create(@CurrentIdentity() identity: TrustedRequestIdentity) {
    return { author: identity.principal.subject };
  }
}
```

## Security posture

- **Fail-closed everywhere.** Any verification failure (bad signature, wrong issuer/audience, expiry, unparseable token) yields anonymous, never a partial identity.
- **RS256-pinned.** The algorithm set is pinned per preset, so `alg:none` and HS-signed forgeries are rejected before any signature check.
- **Audience required.** An empty/unset `aud` is refused, never defaulted open.
- **Expiry required and unit-safe.** Tokens without a finite `exp` are refused; transports receive only `expiresAtMs`.
- **Groups grant nothing by default.** Local roles require an explicit `groupRoles` mapping.
- **No secrets in errors or logs.** Contract-violation messages never echo claim values; the package never logs.

## Testing without a network

The verification key source is injectable (`keySet`), so tests self-host a JWKS in-memory: generate an RS256 keypair with `jose`'s `generateKeyPair`, mint tokens with `SignJWT`, and build a local getter with `createLocalJWKSet` (or pass the public `CryptoKey` directly). No test touches the network.

## API

- Core: `verifyAccessJwt`, `verifyRequest`, `assertVerifyOptions`, `normalizeAudiences`, `readToken`, `cloudflareAccessIssuer`, `genericOidcIssuer`, `getRemoteJwks`, `clearJwksCache`, `jwksCacheSize`, `JWKS_CACHE_MAX`, `defineIdentity`, `createAccessResolver`, `composeResolvers`, `IdentityRejectedError`, and the `AccessClaims` / `IssuerPreset` / `ResolvedIdentity` / `ResolveIdentity` / `IdentityContract` / `StandardSchemaV1` types.
- `@velajs/cloudflare-access/vela`: `CloudflareAccessModule`, `CloudflareAccessGuard`, `CloudflareAccessUpgradeAuthenticator`, `CurrentAccessIdentity`, `identityFromAccess`, `ACCESS_RESOLVER`, and `ACCESS_MODULE_OPTIONS`.

## Shared authorization

Use the permission guards and decorators from `@velajs/authz/vela`. `CurrentIdentity` supplies common authorization state. `CurrentAccessIdentity` remains the provider-specific payload accessor, including `mapClaims` enrichment, and is tied to the exact current core identity so clearing, replacement and expiry invalidate it. Read expiry and tenant from the canonical top-level identity. For custom tenant field names, configure `tenantClaim` instead of assigning `mapClaims().tenantId`.

Use the issuer-qualified principal for authorization. WebSocket upgrade code must read core's trusted identity and require both tenant and finite expiry before allocating a socket.

## Authentication composition

Admitted tenant enrichment preserves CurrentAccessIdentity. That decorator returns verified provider payload, while core CurrentIdentity carries the admitted tenant. Explicitly bound custom HTTP contexts consume existing verified payload; they do not reverify tokens or clear authority across parallel resolver fields.
