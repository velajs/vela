---
'@velajs/vela': minor
'@velajs/cloudflare': minor
'@velajs/ai': minor
'@velajs/crud': minor
'@velajs/crud-drizzle': minor
'@velajs/mail': minor
'@velajs/rpc': minor
'@velajs/studio': minor
'@velajs/testing': minor
'@velajs/storage': minor
---

Remove obsolete contracts and backward-compatibility paths.

Validation now requires Standard Schema or DTO descriptors. Decorated events require event definitions and use EventDispatcher; EventEmitter.emit always settles every matching callback. Remove token-only discovery, instance-based schedule views, ownerless entrypoints, disposed-container reuse, unmanaged scope finalization, and the `(.*)` middleware alias. Queue driver bind returns cleanup and enqueue after inline disposal rejects. Configure HTTP body caps through security.body.maxBytes.

WebSocket clients must report admission with trySendRaw. Tiered caches require expiry-aware read/write methods; KV entries without expiry metadata miss. Aggregate specs use only aggregations, the default CRUD adapter can be undefined, and Studio discovers resources registered through Crud. Remove the Studio path alias, the mail envelope argument overload, the AI embedding resolver fallback, and the obsolete contentHash export.

Storage encryption rejects invalid ciphertext; compression requires format metadata and a metadata-capable store.

Update adapters, examples, tests, API snapshots and migration documentation to the current contracts.
