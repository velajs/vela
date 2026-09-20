# @velajs/live-protocol

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.

## 2.0.0

Shared runtime argument/result parsers and validated live frame contracts used by the server and every client.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.1.0

### Minor Changes

- 6e9d70a: Validate live frame schemas, JSON shape, protocol versions, cursor/epoch pairs, and secure default size limits for frames, deltas, and presence metadata. Outbound encoders now reject malformed or oversized frames before serialization.

## 1.0.1

### Patch Changes

- 0fcf971: Modernize the package build, validation, and release toolchain.
