# @velajs/react-native

React Native / Expo binding for [Vela](https://github.com/velajs) live queries. A
thin composition over [`@velajs/client`](../client) and
[`@velajs/react`](../react) that adds only what a native app needs on top of the
browser SDK.

## What it adds

- **`createNativeClient(options)`** — a `LiveClient` factory tuned for native.
  Pass `storage` (React Native `AsyncStorage` or any `AsyncStorageLike`) and the
  offline mutation queue is persisted durably (browsers auto-persist to
  IndexedDB, which native lacks). `offline` defaults ON when a durable store
  exists. `authToken`, `fetch`, and `WebSocket` pass straight through.
- **`createAsyncStorageMutationStore({ storage, key? })`** — the durable
  `MutationStore` on its own, over a single JSON-array key (FIFO,
  corruption-tolerant).
- **The full `@velajs/react` hook surface** re-exported unchanged
  (`LiveProvider`, `useLiveQuery`, `useLiveMutation`, `usePresence`,
  `useConnectionStatus`, `useClientQuery`, `usePendingMutations`, …). Those hooks
  import only from `react` — no `react-dom`, no required browser global — so
  they run as-is on native.
- **`@velajs/react-native/auth`** — a better-auth Expo bridge behind optional
  peers.

## Native auth — no cookie jar, no CSRF trip

Native has no cookie jar and sends no `Origin`, so a `Cookie`-authenticated
request would be rejected by the server CSRF guard. Vela never uses a cookie: it
carries the credential explicitly — a `Bearer` header on HTTP mutations and a
`?token=` query param on the live socket — both fed by the single
`LiveClientOptions.authToken` provider, re-invoked on every mutation and every
(re)connect so a rotated token is picked up automatically.

```ts
import { createNativeClient } from '@velajs/react-native';
import { expoAuthToken } from '@velajs/react-native/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';

const client = createNativeClient({
  url: 'https://api.example.com',
  storage: AsyncStorage,
  authToken: expoAuthToken(authClient), // reads the better-auth session token
});
```

## Auth bridge (`@velajs/react-native/auth`)

```ts
import { expoBearerToken, expoAuthToken, expoClient } from '@velajs/react-native/auth';
```

- `expoBearerToken(authClient)` → the current session token as a `string`, or
  `null` when signed out. Regex-free cookie parsing (ReDoS-safe).
- `expoAuthToken(authClient)` → a `() => string | undefined` ready for
  `authToken`.
- `expoClient` — re-exported from `@better-auth/expo/client` (optional peer).

`@better-auth/expo` and `better-auth` are optional peers — only the `./auth`
subpath needs them.

## Not in v0.1

Reconnect-on-foreground (`AppState`) is deferred: it needs a small additive
`LiveClient.reconnect()` core lever first. The existing auto-reconnect covers the
clean-close case.

## License

MIT
