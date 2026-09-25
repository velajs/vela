# @velajs/agent

## 1.28.2

### Patch Changes

- dad610c: Publish the `@velajs/mail` peer range the repository declares: `^1.31.0`, the release that builds `MailModule` on `defineModule`. @velajs/agent 1.28.1 was published with `^1.29.0`, while later releases raised the range in the repository without publishing it. Install @velajs/mail 1.31.0 or later with this version. The agent imports only mail's `InboundEmail` type and has no other changes.
- Updated dependencies [b227d22]
  - @velajs/mail@1.31.0

## 1.28.1

### Patch Changes

- Updated dependencies [bacaacd]
- Updated dependencies [9d5bccc]
- Updated dependencies [4071cb7]
- Updated dependencies [e3bda2a]
  - @velajs/errors@1.23.0
  - @velajs/mail@1.29.0
  - @velajs/workflow@1.0.2

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

### Patch Changes

- Updated dependencies
  - @velajs/mail@1.28.0

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/mail@3.0.0

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
