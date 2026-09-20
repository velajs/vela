# @velajs/authz

Framework-agnostic permission/role engine for Vela: `defineRole`, fail-closed `can()`, composition + masking helpers. **Zero runtime dependencies, edge-runtime safe** (no `node:*`, no `Buffer`, no `process`).

## Why

Authorization is one decision — *"is this identity allowed to do this?"* — that has to be answered identically across HTTP, WebSocket, live queries, and background jobs. This package is that single answer. It resolves an `Identity` to a set of granted permissions and decides `can()` **fail-closed**: absent a session, the [`anonymous`](#identity) zero-privilege identity is used and nothing is granted.

The core is a plain function library — no decorators, no container, no framework coupling. Optional [Vela integration](#vela-integration) lives behind a subpath.

## Install

```sh
pnpm add @velajs/authz
```

## Quick start

```ts
import { createAuthz, defineRole } from '@velajs/authz';

const authz = createAuthz({
  roles: [
    defineRole('editor', ['posts:read', 'posts:write']),
    defineRole('admin', ['*']),
  ],
});

await authz.can({ roles: ['editor'] }, 'posts:write'); // true
await authz.can({ roles: ['editor'] }, 'posts:delete'); // false
await authz.can({ roles: ['admin'] }, 'anything:at:all'); // true (wildcard)
```

## The model

- **`Identity`** — who is asking. All fields optional, so `{}` and `anonymous` are valid zero-privilege identities.
- **`defineRole(name, permissions)` / `definePermission(name)`** — declare the role→permission table. `defineRole` copies the permissions array, so the returned `RoleDef` never aliases the caller's input.
- **`createAuthz(options)`** — builds an `Authz` over a role table (or a custom `resolver`). Returns `{ can, resolver }`. If you pass a `permissions` allow-list, `createAuthz` throws when a role grants an **undeclared** (non-wildcard) permission — a build-time guard against typos.
- **`can(identity, permission, resolver)`** — the standalone fail-closed check; `authz.can(identity, permission)` is the same check bound to the built resolver.

```ts
interface Identity {
  issuer?: string;
  subject?: string;
  principalType?: 'user' | 'service';
  /** @deprecated compatibility alias for subject */
  userId?: string;
  roles?: string[];
  claims?: Record<string, unknown>;
}

interface PermissionResolver {
  grants(identity: Identity): Set<string> | Promise<Set<string>>;
}
```

Authenticated adapters should populate `{ issuer, subject, principalType }`. Treat the `(issuer, subject)` pair as the durable principal key: OIDC subjects are issuer-local and can collide across identity providers. `userId` remains as a compatibility alias while applications migrate.

`anonymous` is the zero-privilege identity (`{ roles: [] }`, frozen) — the fail-closed default when no session is present.

## Wildcards

A granted permission string matches the requested permission when:

- it is `*` — grants **everything**;
- it equals the requested permission exactly (e.g. `posts:write`);
- it is `resource:*` — grants **any action** under that resource (e.g. `posts:*` grants `posts:delete`).

Wildcards live on the **granted** side (what a role holds), not the requested side.

## Fail-closed rules

Authorization defaults to **deny**. Every ambiguous or broken path denies rather than leaks:

- No session → use `anonymous` → grants nothing.
- Unknown role / missing permission → denied.
- A resolver that **throws** → denied (there is no allow-on-error path).
- **`anyOf()` with no policies → denied** (nothing grants access).
- A policy that **throws** inside `anyOf`/`allOf` → that branch is denied; it can never allow.
- **`mask`** whose transform throws → redacts to `null`, never leaks the raw value.

(`allOf()` with no policies is vacuously `true` — an empty AND — but an empty OR denies.)

## Composition + masking

`Policy` is a plain predicate over a context and a resource:

```ts
type Policy<C = { identity: Identity }, R = unknown> =
  (ctx: C, resource: R) => boolean | Promise<boolean>;
```

Combine capability checks with resource-level rules (ownership, tenancy, state):

- **`anyOf(...policies)`** — OR, read semantics. Any policy granting → allowed. Empty → denied.
- **`allOf(...policies)`** — AND, write semantics. All must allow.
- **`hasPerm(authz, permission)`** — bridge a capability check into a `Policy` that reads only `ctx.identity`.
- **`mask(fn)`** — wrap a field transform so a throw redacts to `null` instead of leaking.

```ts
import { anyOf, allOf, hasPerm, mask } from '@velajs/authz';

const isOwner = (ctx: { identity: { userId?: string } }, post: { authorId: string }) =>
  ctx.identity.userId === post.authorId;

// A reader may see a post if they own it OR hold posts:read.
const canRead = anyOf(isOwner, hasPerm(authz, 'posts:read'));

// A writer must own it AND hold posts:write.
const canWrite = allOf(isOwner, hasPerm(authz, 'posts:write'));

await canRead({ identity: { userId: 'u1', roles: [] } }, { authorId: 'u1' }); // true

// Redact a sensitive field, fail-closed to null on any error.
const lastFour = mask((_ctx: unknown, r: { ssn: string }) => r.ssn.slice(-4));
lastFour({}, { ssn: '123456789' }); // '6789'
```

## Vela integration

Optional. `@velajs/authz/vela` wires the engine into a Vela app. `@velajs/vela` is an **optional** peer dependency — the core engine has no framework coupling and runs anywhere (edge, Node, Workers, Deno, Bun).

The framework entrypoint owns the shared `PermissionGuard` / `RequirePermission` (all permissions), `RolesGuard` / `Roles` (any local role), and `CurrentIdentity` decorator. Authentication providers publish verified state into core; these guards never infer identity from request headers, Hono variables, compatibility symbols, or Better Auth user metadata.

`getContextIdentity(context)` reads core's unexpired HTTP identity, or the normalized WebSocket connection principal/tenant/expiry. Socket role or claim fields are not authority; a permission resolver can look up grants using the connection principal and tenant. HTTP role/claim snapshots cannot be mutated after publication.

The permission guard resolves exactly one `AUTHZ` engine visible from the route module, then rechecks identity after asynchronous decisions to reject expiry or replacement during resolution. `can()` also rejects expired identities before and after invoking its resolver. Missing identity, missing/ambiguous engine, and resolver exceptions deny access.

```ts
import { AuthzModule, PermissionGuard, RequirePermission } from '@velajs/authz/vela';

@UseGuards(CloudflareAccessGuard, PermissionGuard) // or AuthGuard, PermissionGuard
@Controller('/posts')
class PostsController {
  @Post()
  @RequirePermission(['posts:write'])
  create() { /* ... */ }
}
```

## License

MIT © Kauan Guesser
