// `@velajs/react-native` is the React Native / Expo entry to Vela. The hooks,
// provider, and client-query surface are the exact same building blocks as
// `@velajs/react` — they import only from `react` (never `react-dom` or a
// required browser global), so they run unchanged on native. Rather than fork
// them, re-export the whole surface and add the two things a native app needs:
// a native-tuned client factory (AsyncStorage-backed offline queue; the bearer
// auth story rides the existing seams) and, from `./auth`, a better-auth Expo
// bridge.
export * from '@velajs/react';

export { createNativeClient } from './create-native-client';
export type { CreateNativeClientOptions } from './create-native-client';
export { createAsyncStorageMutationStore, DEFAULT_MUTATION_STORE_KEY } from './async-storage-store';
export type { AsyncStorageLike } from './types';
