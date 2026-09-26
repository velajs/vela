# Cloudflare retrieval

## Choose the ownership boundary

`@velajs/ai/rag` owns chunking, embedding and generation publication over a
`RagVectors` store. Cloudflare AI Search owns its own indexing pipeline. The
optional `@velajs/ai/ai-search` subpath adds request authority, validation, citations
and AI SDK tools to managed search. It does not implement `RagVectors`, redefine
the AI SDK's model interface, or add a DI module. These retrieval responsibilities
belong beside the existing AI tools; a separate package would not own another
independent capability.

Use native bindings directly for instance creation, built-in storage, indexing,
administration, and generation. The helper only consumes namespace-level search.
The [current namespace API](https://developers.cloudflare.com/ai-search/api/search/workers-binding/)
can search multiple selected instances in one namespace. Its results identify the
originating instance. No legacy `env.AI.autorag()` API is used here.

## Bind authority to a verified request

```jsonc
{
  "ai_search_namespaces": [{ "binding": "AI_SEARCH", "namespace": "manuals" }]
}
```

```ts
import { createAiSearch } from '@velajs/ai/ai-search';

// These application functions validate identity and consult authoritative storage.
const identity = await requireVerifiedIdentity(request);
const instanceIds = await catalog.readableInstances(identity);
const search = createAiSearch({
  binding: env.AI_SEARCH,
  instanceIds,
  maxResults: 10,
  authorizeSource: ({ instanceId, key }) =>
    catalog.canReadPublishedItem(identity, instanceId, key),
});

const result = await search.retrieve(question);
// Or pass this per-request tool to generateText/streamText through the AI SDK.
const tools = { search: search.asTool() };
```

The catalog is application-owned, not an additional Vela service. Its decision
must check current identity validity, tenant/instance membership, source ACL,
deletion status, and that this immutable item key is the published revision. Do
not derive authorization from search metadata, a model argument, or request JSON
claimed to be an identity. A denied or missing source returns `false`; storage or
policy failures should throw. Only literal `true` permits the item.

Instance IDs and the namespace binding come from trusted server configuration
and verified membership. A namespace can contain instances belonging to different
tenants; access to the namespace binding alone is not tenant authorization. Never
copy a request's instance list into this configuration without authorization.
Empty instance lists fail closed. A search with no authorized instances should
be handled by the application without calling the service.

The callback receives only validated `{ instanceId, key }`, without indexed ACLs
or model-controlled authorization fields. It runs once per distinct returned item
per retrieval, even when reusing the same tool for several model steps. Decisions
are not cached across calls. Construct helpers per request and environment; do
not place identity closures or bindings in process-global state. Authorization
reflects each callback's authoritative read, not a transaction across all sources
or a guarantee against a revocation occurring after that read.

## Immutable items and native ingestion

Write a new immutable physical item key for every revision, such as
`guide/<random-revision>.md`. Never overwrite or reuse a published key with
different content, including after deletion. Otherwise a stale chunk and a new
chunk can share the same authorization identity, so no key-only check can
distinguish them. Restrict ingestion credentials to trusted writers.

The [native Items API](https://developers.cloudflare.com/ai-search/api/items/workers-binding/)
uploads into built-in storage. `upload()` queues processing; `uploadAndPoll()`
waits for indexing status. Neither operation commits your application catalog.

```ts
// A trusted writer has already authorized the tenant, source and target instance.
const instance = env.AI_SEARCH.get(authorizedInstanceId);
const key = `guide/${crypto.randomUUID()}.md`;
const staged = await instance.items.uploadAndPoll(key, markdown, {
  timeoutMs: 30_000,
});
if (staged.status !== 'completed') throw new Error('Indexing did not complete');

// Application transaction/CAS under a per-source writer lock:
// publish this key together with the source ACL, retaining staged.id for cleanup.
await catalog.publishRevision(verifiedWriter, sourceId, { key, itemId: staged.id });
```

Serialize writers or use compare-and-swap in authoritative storage. A failed
indexing attempt leaves its key unpublished and unreadable through the helper;
record failed/ambiguous uploads for reconciliation. Publishing a replacement
must atomically unpublish the old key and publish the new key with the intended
ACL. Only after that commit should native `items.delete(oldItemId)` reclaim the
old item. Keep failed cleanup work for retry.

For deletion or access revocation, update the authoritative tombstone/ACL first.
Then remove the native item or obsolete revision. Subsequent authorization checks
reject stale hits regardless of indexing delay. If re-sync changes ACLs, publish
the new key and ACL together. ACL-only revocation can deny the existing immutable
key immediately; it must not wait for metadata re-indexing. Never permit a direct
search/download endpoint or a model tool to bypass these checks.

This protocol trades availability for safe filtering when native search still
returns old candidates. It does not promise atomic native indexing, exhaustive
recall, read-after-write visibility at every location, or successful rollback of
acknowledged remote mutations. The credential-free
[example](../examples/managed-search.mjs) deliberately returns stale candidates
to demonstrate replacement, revocation and deletion decisions.

## Results and limits

`retrieve(query)` and `asTool().execute({ query }, ...)` return:

```ts
{
  context: '[source:1]\nA passage.',
  chunks: [{ text: 'A passage.', score: 0.8, citation: {
    id: '1', instanceId: 'manuals-a', key: 'guide/revision-a.md', chunkId: 'chunk-1'
  } }],
  citations: [{
    id: '1', instanceId: 'manuals-a', key: 'guide/revision-a.md', chunkId: 'chunk-1'
  }]
}
```

Citation IDs are local to the result, assigned after authorization. Raw keys
never become context headers or automatic links. Resolve source links through
your authorized application route and recheck permission there. Chunk text is
untrusted reference data and may contain instructions or fabricated citation
markers; keep tool permissions outside prompts.

The helper validates UTF-8 strings, finite scores in `[0, 1]`, text chunk type,
originating instance, source key and chunk ID. Malformed and unauthorized chunks
are omitted; duplicates use the complete instance/key/chunk tuple. Extra native
metadata, rewritten queries and scoring internals are not exposed. Invalid
response envelopes, native errors and partial-instance failures reject retrieval.
It disables similarity caching and native failure fallback and requests no
context expansion; live authorization remains necessary regardless of caching.

Limits: 1–10 distinct instances (256 bytes per ID); `maxResults` 1–50 (default 10);
32 KiB nonempty query; 1 KiB chunk ID; 4 KiB item key; 64 KiB text per chunk; and
512 KiB assembled context. Tool validation also runs on direct execution. Candidate
inspection and authority calls are bounded by `maxResults`; denied/stale candidates
can reduce the final count. The helper does not issue speculative refill searches.

Tests check the native namespace's TypeScript compatibility, request isolation,
failure handling, and runtime behavior in workerd without Node compatibility.
AI Search local development requires a remote binding; the workerd test uses a
controlled search response and is not a live indexing/consistency test. To verify
a provisioned service, upload synthetic immutable items, confirm completed status,
search with current authority, publish a replacement, revoke access, and tombstone
the source while checking that stale results are denied. No live resources are
created by the package tests.

## Vectorize-owned retrieval

For application-owned chunking and embeddings, use the optional
[`@velajs/ai/vectorize` driver](vectorize.md) with a required authoritative
publication store. The redesigned `RagVectors` contract explicitly permits
asynchronous indexing and separates search candidates from revision/ACL authority.
It does not infer query visibility from mutation receipts or processed markers.
Existing custom RAG stores must follow the [migration guide](rag-migration.md).
