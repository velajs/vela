---
'@velajs/ai': patch
---

Bring the provider-neutral AI and RAG package into the 1.x monorepo. Keep AI SDK
7 model resolution and direct primitive exports; support the current
`embeddingModel` provider method and remove the untyped `run`/`AiBinding`
passthrough. Use native platform bindings directly for those calls.

Encode tenant and embedding-model partitions without collisions, drain pending
writes before failed-sync cleanup, include chunk output and text-storage mode in
re-sync fingerprints, and validate retrieval-tool inputs. Existing legacy indexes
must be re-synced into the new namespace format. Providers remain application
choices; the package requires only the AI SDK peer.
