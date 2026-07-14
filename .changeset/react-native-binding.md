---
"@velajs/react-native": minor
---

Add `@velajs/react-native`: the React Native / Expo binding. A thin composition over `@velajs/client` and `@velajs/react` — an AsyncStorage-backed offline `MutationStore` (`createAsyncStorageMutationStore`), a native-tuned client factory (`createNativeClient`) that maps `storage` to that store and defaults the offline queue on, the react-dom-free `@velajs/react` hook surface re-exported unchanged, and a `@velajs/react-native/auth` better-auth Expo bridge behind optional peers. The native bearer auth story (Bearer header on HTTP, `?token=` on the live socket) rides the existing `LiveClientOptions.authToken` seam with zero core changes.
