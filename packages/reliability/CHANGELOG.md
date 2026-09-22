# @velajs/reliability

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [a2d2692]
  - @velajs/crud@2.0.0
  - @velajs/crud-drizzle@2.0.0

## 1.1.0

### Minor Changes

- 2addbe3: Add independently usable durable idempotency, outbox, inbox and one-off scheduling APIs with tenant namespaces, bounded payloads and HTTP replay, leases, fencing, retries and restart recovery. Provide optional PostgreSQL/async SQLite Drizzle transaction integration, native D1 compare-and-set operations and authenticated unconditional outbox admission. Document at-least-once execution and reject unsupported fenced D1 composition before writes.

### Patch Changes

- Updated dependencies [2addbe3]
- Updated dependencies [2addbe3]
  - @velajs/crud-drizzle@1.26.0
  - @velajs/crud@1.27.0
