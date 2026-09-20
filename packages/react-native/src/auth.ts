/**
 * `@velajs/react-native/auth` — the better-auth Expo bridge. Wires a native app
 * from one import: `expoBearerToken`/`expoAuthToken` (the session-token readers,
 * living in the peer-free `./bearer` module so they unit-test without Expo
 * native shims) plus `expoClient`, re-exported from `@better-auth/expo/client`
 * so this subpath is the single place a native app reaches for auth.
 *
 * `@better-auth/expo` and `better-auth` are OPTIONAL peers — only this subpath
 * pulls them in; the package root ({@link createNativeClient}, the hooks) has no
 * auth dependency.
 */
export { expoBearerToken, expoAuthToken } from './bearer';

/**
 * The synchronous key/value slice the better-auth Expo plugin needs — the shape
 * of `expo-secure-store` (`getItem`/`setItem`). Pass Expo `SecureStore` in
 * directly. Structural on purpose: nothing here imports `expo-secure-store`.
 */
export interface SecureStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
}

// The better-auth Expo client plugin (session persisted in SecureStore, OAuth
// via the app scheme). Deliberately NOT re-exporting better-auth's TanStack
// Query focus/online managers: `@velajs/react` uses no react-query, so there is
// nothing for them to drive on this binding.
export { expoClient } from '@better-auth/expo/client';
