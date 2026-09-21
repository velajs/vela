# Changelog

All notable changes to `@velajs/ai` are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.1

### Patch Changes

- 479b70a: Bring the provider-neutral AI and RAG package into the 1.x monorepo. Keep AI SDK
  7 model resolution and direct primitive exports; support the current
  `embeddingModel` provider method and remove the untyped `run`/`AiBinding`
  passthrough. Use native platform bindings directly for those calls.

  Encode tenant and embedding-model partitions without collisions, drain pending
  writes before failed-sync cleanup, include chunk output and text-storage mode in
  re-sync fingerprints, and validate retrieval-tool inputs. Existing legacy indexes
  must be re-synced into the new namespace format. Providers remain application
  choices; the package requires only the AI SDK peer.

## 1.0.0

Monorepo baseline; publication is managed by the root Changesets workflow.

- Preserve model resolution, direct AI SDK exports, and the independent RAG entrypoint.
- Support the AI SDK 7 `embeddingModel` provider method with the older method as fallback.
- Remove the untyped raw binding wrapper (`run`, `binding`, `AiBinding`); use native bindings directly.
- Disambiguate model/tenant namespaces, drain writes before rollback, fingerprint chunk output and text-storage mode, and validate retrieval-tool input at runtime. Legacy indexes require re-sync.
- Retain the original MIT license and standalone history below. The hardened standalone source had already moved sync fingerprints from FNV to SHA-256; `contentHash` remains a separate compatibility utility.

## 0.1.0

Initial release — the provider-neutral AI core for Vela.

### Added

- **`createAi`** — the model-resolution seam. `model()` / `embeddingModel()` accept either a model-id string (resolved through a configured provider-neutral `AiProvider`) or a built AI SDK model object (bring-your-own), and `run()` is a raw inference-binding escape hatch. Zero platform imports; the Cloudflare Workers AI wiring is a documented adapter over `AiProvider` / `AiBinding` left to `@velajs/cloudflare`.
- **AI SDK re-exports** — `generateText`, `streamText`, `embed`, `tool`, `jsonSchema` (and the `LanguageModel`, `EmbeddingModel`, `Tool` types), so an app has one import for the whole inference surface. `ai` is a peer dependency.
- **`@velajs/ai/rag`** — `defineRag(config)` → `{ sync, retrieve, remove, asTool }` over a bring-your-own `RagVectors` store (`upsert` / `query` / `getByIds` / `deleteByIds`, all namespace-scoped, taking precomputed vectors) and a `config.embed` embedder. Safety defaults: `requireNamespace` tenant isolation with a one-time shared-namespace warning, an RLS-style filter merge where caller filters can never widen access, and `embeddingModelVersion` vector-space partitioning. Content-hash re-sync skip via a synchronous FNV-1a hash (`contentHash`, change-detection only). Ranking controls: `minScore`, per-document `importance`, and `chunkContext` neighbour expansion. Ships `memoryVectors()` as an in-memory reference store.
