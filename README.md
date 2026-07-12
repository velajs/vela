# @velajs/authz

Framework-agnostic permission/role engine for Vela: `defineRole`, fail-closed `can()`, composition + masking helpers. Zero runtime dependencies, edge-runtime safe.

## Why

Authorization is one decision — *"is this identity allowed to do this?"* — that has to be answered identically across HTTP, WebSocket, live queries, and background jobs. This package is that single answer. It resolves an `Identity` to a set of granted permissions and decides `can()` **fail-closed**: absent a session, the [`anonymous`](#identity) zero-privilege identity is used and nothing is granted.

## Identity

```ts
interface Identity {
  userId?: string;
  roles?: string[];
  claims?: Record<string, unknown>;
}
```

`anonymous` is the zero-privilege identity (`{ roles: [] }`) — the fail-closed default when no session is present.

A `PermissionResolver` turns an identity into the set of permissions it holds:

```ts
interface PermissionResolver {
  grants(identity: Identity): Set<string> | Promise<Set<string>>;
}
```

## Roles and permissions

```ts
import { defineRole, definePermission } from '@velajs/authz';

const editor = defineRole('editor', ['posts:read', 'posts:write']);
// → { name: 'editor', permissions: ['posts:read', 'posts:write'] }

const write = definePermission('posts:write');
// → { name: 'posts:write' }
```

`defineRole` copies the permissions array, so the returned `RoleDef` never aliases the caller's input.

## Vela integration

Optional. `@velajs/authz/vela` wires the engine into a Vela app. `@velajs/vela` is an **optional** peer dependency — the core engine has no framework coupling.

## License

MIT © Kauan Guesser
