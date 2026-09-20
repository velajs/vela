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
  exists. Durable mode requires a stable `identity` account+login-epoch fingerprint.
  `authToken`, `socketTicket`, `fetch`, and `WebSocket` pass straight through.
- **`createAsyncStorageMutationStore({ storage, key? })`** — the durable
  `MutationStore` on its own, over one account-epoch-partitioned JSON-array key (FIFO,
  corruption-tolerant).
- **The full `@velajs/react` hook surface** re-exported unchanged
  through `createLiveHooks<Contract>()`, which returns the provider and its typed hooks. Those hooks
  import only from `react` — no `react-dom`, no required browser global — so
  they run as-is on native.
- **`@velajs/react-native/auth`** — a better-auth Expo bridge behind optional
  peers.

## Native auth — no cookie jar, no CSRF trip

Native has no browser cookie jar or automatic `Origin`. HTTP mutations use the
`authToken` bearer provider. WebSocket URLs never contain that bearer token;
provide `socketTicket`, backed by an authenticated endpoint that mints a
30-second, room-bound, single-use ticket. Durable offline mode also requires a
stable, non-secret `identity` account+login-epoch fingerprint.

```ts
import { createNativeClient } from '@velajs/react-native';
import { expoAuthToken } from '@velajs/react-native/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { queries } from './shared/live';

const client = createNativeClient({
  queries,
  url: 'https://api.example.com',
  storage: AsyncStorage,
  authToken: expoAuthToken(authClient), // reads the better-auth session token
  identity: () => `${authClient.getAccountId()}:${authClient.getLoginEpoch()}`, // not a token
  socketTicket: (room) => mintSocketTicket(room),
});
```

On logout/account switch, capture the previous fingerprint, clear the auth state
so `identity()` no longer returns it, and then call
`await client.purgeOfflineMutations(previousFingerprint)`. This removes only
that account/login-epoch partition from AsyncStorage; `client.close()` keeps it
for normal app-restart recovery.

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

## Connection lifecycle

The client retries closed connections automatically. The native adapter does not
integrate with React Native's `AppState` foreground events.

## License

MIT
