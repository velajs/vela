# RAG publication migration

This is a breaking 1.x minor release. Rebuild the RAG index from authoritative source
documents into a fresh partition; old in-index manifests are never read or migrated
automatically. Keep old readers/writers separated until cutover, then retire their
index partitions after draining all writers.

1. Supply required `publications`. Use `memoryPublications()` for local demos or
   a durable serializable `RagPublications` implementation. Workers can use
   `durableObjectPublications(this.ctx.storage)` from `@velajs/ai/vectorize`.
   Route all reads/writes for a scope to the same authority. Remove `textStore`
   and `RagTextStore`: publication storage now owns text and ACL metadata.
2. Update custom `RagVectors`: retain only `upsert`, `query`, `deleteByIds`,
   and required `maxTopK`. Remove portable by-ID, metadata, filter and projection
   APIs/types. Return `{ status: 'visible' | 'accepted', mutationIds: string[] }`
   from writes. An asynchronous receipt must return `accepted`. Query returns
   only `{ id, score }` candidates with finite nonnegative similarity. Normalize
   distance/signed scores appropriately and recalibrate `minScore` thresholds.
   Memory cosine now uses `(cosine + 1) / 2`, except zero norm returns zero.
3. Save the revision returned by sync. Omitted/null `expectedRevision` is create
   only; every replacement or remove requires the last token. Use trusted
   `inspect(id, scope)` after ambiguous outcomes. Never automatically fetch and
   replace on behalf of a stale job without checking its business ownership.
4. Authorize `inspect` and `reconcile` as writer operations in `resolveNamespace`.
   They expose or mutate publication/recovery state. Existing `sync`, `retrieve`,
   `remove` and tool tenant authorization remain required.
5. Treat publication and indexing as separate states. A replacement revokes old
   content before indexing; errors leave pending work and reduced availability,
   not the old ACL/content. `remove` returns a tombstone without waiting for index
   deletion. Follow it with bounded `reconcile` journal sweeps for physical cleanup.
6. Handle `RagIndexingError` by recording its source/revision and retrying
   `reconcile`. A lost initial storage response requires `inspect`. Abort signals
   leave resumable pending work; remove its revision to cancel permanently.
   Deleted/superseded revisions cannot resume. Keep the embedder fixed for a model
   partition because reconciliation may re-embed pending text; use `reindex: true` to resubmit published text.
7. Plan journal quota/retention and application scheduling. The library does not
   start background work, retry forever, delete tombstones, or certify that delayed
   mutations have stopped. Retired journals retain only revision/count data.

Filters now run only on current authoritative metadata. A bounded candidate query
may return fewer authorized results than `topK`, including zero while old matches
occupy the index. No pagination/refill guarantee is implied. Vectorize uses at most
50 candidates and stores no application metadata. See [Vectorize](vectorize.md)
for its ID mapping, score transforms, native limits and live-test limitations.
