import type { LiveClientOptions } from '@velajs/client';

/**
 * The async key/value slice the native mutation store needs — structurally the
 * `@react-native-async-storage/async-storage` surface (also satisfied by an
 * in-memory `Map` wrapper in tests, or any store with the same three async
 * methods). This is a STRUCTURAL seam on purpose: nothing in `src` imports
 * `react-native` or `expo`, so the package builds and unit-tests on plain Node.
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Options for {@link createNativeClient} — every {@link LiveClientOptions} field
 * plus two native conveniences. `storage` wires an AsyncStorage-backed durable
 * offline mutation store (browsers auto-persist to IndexedDB, which React Native
 * lacks — without it the queue lives only in memory and is lost on reload).
 * `mutationStoreKey` overrides the single storage key the records serialize
 * under.
 *
 * An explicit `mutationStore` takes precedence over `storage`, and an explicit
 * `offline` (including `false`) takes precedence over the store-derived default.
 * The native bearer story rides the existing {@link LiveClientOptions.authToken}
 * seam untouched (Bearer header on HTTP, `?token=` on the live socket).
 */
export interface CreateNativeClientOptions extends LiveClientOptions {
  /**
   * React Native `AsyncStorage` (or any {@link AsyncStorageLike} store). When
   * supplied and no explicit `mutationStore` is given, the offline mutation
   * queue is persisted here so writes made offline survive an app restart.
   */
  storage?: AsyncStorageLike;
  /** Storage key the persisted mutation array serializes under. Default `velajs.mutations`. */
  mutationStoreKey?: string;
}
