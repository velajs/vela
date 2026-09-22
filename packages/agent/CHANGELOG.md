# @velajs/agent

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Patch Changes

- Updated dependencies [a2d2692]
  - @velajs/mail@2.0.0

## 1.0.1

### Patch Changes

- b4e705a: Migrate durable agent orchestration into the 1.x monorepo. Add atomic run claims and completed-delivery results, scoped tool and sub-agent idempotency, validated bounded external data, recoverable approval challenges, and accurate agent stop conditions. Preserve portable root, MCP, and testing exports and document the corrected store and integration contracts.
- Updated dependencies [479b70a]
- Updated dependencies [26cea98]
- Updated dependencies [098dfea]
  - @velajs/ai@1.0.1
  - @velajs/mail@1.0.1
  - @velajs/workflow@1.0.1

## 0.1.0

- Initial release.
