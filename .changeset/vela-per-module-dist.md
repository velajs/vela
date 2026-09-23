---
'@velajs/vela': patch
---

Publish `@velajs/vela` as one JavaScript module per source file instead of shared chunks, so a bundler drops every feature a Worker never imports. A shared chunk kept each decorated feature class it held, because `X = __decorate([...], X)` is a side effect a bundler must keep once any export of that chunk is used, and `VelaFactory` shared a chunk with the root barrel's features. The reference Worker in `scripts/fixtures/worker-size-entry.ts` (one controller and `VelaFactory.create`) shrinks from 66,783 to 51,206 bytes gzipped. Entry points, exports and type declarations are unchanged. The `sideEffects` list now names only files the build emits: `dist/metadata.js`, which holds the Reflect metadata polyfill, was listed before but its code was inlined into a hashed chunk.

`@Cron`, `@Interval` and `@Processor` declare their entrypoint kinds when their modules load, so a bundle that never imports them no longer lists those kinds in `getEntrypointKinds()`. `app.entrypoints` is unaffected: it only lists kinds that have entrypoints.
