# @velajs/ai

Provider-neutral model selection and tenant-scoped retrieval for Vela applications.
The base and RAG entrypoints also work independently of Vela and Cloudflare.

- **`@velajs/ai`** supplies `createAi` to configure model defaults once per application,
  while services accept either provider model IDs or existing SDK models.
- **`@velajs/ai/rag`** supplies `defineRag` for ingestion, authorized retrieval,
  content re-sync, and request-bound AI SDK search tools over your vector store.
- **`@velajs/ai/ai-search`** supplies `createAiSearch` for Cloudflare's managed
  retrieval, validated citations, and request-bound tools with current source authorization.

Use the [Vercel AI SDK](https://ai-sdk.dev) directly when your application already
owns model selection and retrieval. Vela adds no inference protocol, agent loop,
provider registry, or ingestion wrapper. `generateText`, `streamText`,
`embed`, `tool`, and `jsonSchema` are unchanged SDK re-exports; import other SDK
features from `ai`.

## Install and compatibility

```sh
pnpm add @velajs/ai ai@^7.0.26 zod@^4.4.3
```

The workspace tests AI SDK **7.0.26** with **Zod 4.4.3**, TypeScript 7 and Node 24.
The supported SDK peer is `^7.0.26`. AI SDK 7.0.26 accepts Zod
`^3.25.76 || ^4.1.8`; this package uses the SDK's JSON-schema validator for its
RAG tool and does not import Zod itself. Install a compatible provider only when
you use it. No entrypoint requires a specific provider, Vela, or Workers SDK dependency.
The AI SDK's own transitive dependencies still apply. A type-only
`@types/json-schema` dependency supplies declarations referenced by SDK 7.0.26.
For strict SDK declaration checking, also install `@types/node` in your application
and include `node` in TypeScript's `types` list; this does not add Node runtime
imports to Vela's portable code.

Portable package code uses Web APIs, including `crypto.subtle` for SHA-256.
It can run in Workers, modern browsers, and Node. Native platform calls such as
`env.AI.run(...)` keep their platform types when called directly.

## Model selection

```ts
import { createAi, generateText, embed, type AiProvider } from '@velajs/ai';

export function supportModels(provider: AiProvider) {
  const models = createAi({
    provider,
    defaultModel: 'your-chat-model',
    defaultEmbeddingModel: 'your-embedding-model',
  });
  return {
    answer: (prompt: string) => generateText({ model: models.model(), prompt }),
    embedding: (value: string) => embed({ model: models.embeddingModel(), value }),
  };
}
```

`createAi(options?)` returns `{ model, embeddingModel }`:

| Resolver | String | SDK model object | Omitted input |
| --- | --- | --- | --- |
| `model(input?)` | Calls `provider(id)` | Passed through | Uses `defaultModel` |
| `embeddingModel(input?)` | Calls `provider.embeddingModel(id)` | Passed through | Uses `defaultEmbeddingModel` |

Missing defaults, providers, or embedding support throw
directed errors. Strings always go through the supplied provider; this avoids
implicitly selecting the AI SDK gateway. To use the gateway's string resolution,
pass strings directly to the SDK instead.

In Vela, register the configured instance through a checked provider:

```ts
import { defineProvider, InjectionToken } from '@velajs/vela';
import { createAi, type Ai, type AiProvider } from '@velajs/ai';

export const MODEL_PROVIDER = new InjectionToken<AiProvider>('MODEL_PROVIDER');
export const AI = new InjectionToken<Ai>('AI');
export const aiProvider = defineProvider(AI, {
  inject: [MODEL_PROVIDER],
  useFactory: (provider) => createAi({ provider, defaultModel: 'your-chat-model' }),
});
```

Your application supplies `MODEL_PROVIDER`, constructed from its environment
credentials/bindings. Construct instances per application environment; do not
cache a provider holding one environment's credentials in a process-global
singleton. Request identity belongs in operation arguments, never mutable shared
configuration. A separate `AiModule` would only duplicate Vela's existing DI API.

## Workers AI and AI Gateway composition

The [native composition example](../../apps/cloudflare-composition/README.md) uses
`workers-ai-provider@4.0.0` with AI SDK 7.0.26 and the existing `createAi` API. It
constructs the provider from each request's `env.AI`, fixes the model and output
limits on the server, and selects AI Gateway through the provider's native gateway
option. Request-bound tools validate input and capture authorized ownership.
Streaming failures and cancellation propagate through an owned deadline; forwarding
an abort signal does not confirm upstream inference cancellation. The example
includes local contract/native tests and a separate opt-in deployed-fixture check.

## Retrieval

`defineRag` owns chunking, embedding and authoritative publication. Supply both
`vectors` (candidate search) and `publications` (serializable revision, text and
ACL storage). Construct them per environment; every writer and reader of an index
must use the same authority. No I/O runs at construction.

```ts
import { defineRag } from '@velajs/ai/rag';

const docs = defineRag({
  vectors: myVectorIndex,
  publications: myPublicationStore,
  embed: async text => (await embed({ model: models.embeddingModel(), value: text })).embedding,
  embeddingModelVersion: 'manuals-v1',
  resolveNamespace: ({ selector, auth, operation }) =>
    authorizeIndexOperation(auth, selector, operation).tenantId,
  rlsFilter: auth => ({ team: requireIdentity(auth).team }),
});
const [created] = await docs.sync([
  { id: 'guide', text: manual, metadata: { team: 'support' } },
], { auth: writerIdentity });
const [updated] = await docs.sync([
  { id: 'guide', text: revisedManual, metadata: { team: 'support' },
    expectedRevision: created.revision },
], { auth: writerIdentity });
const result = await docs.retrieve(question, { auth: verifiedIdentity });
const search = docs.asTool({ auth: verifiedIdentity });
const tombstone = await docs.remove('guide', {
  auth: writerIdentity, expectedRevision: updated.revision,
});
await docs.reconcile('guide', { auth: writerIdentity, revision: tombstone.revision });
```

`sync` returns `revision`, `publication`, `indexing`, chunk count/IDs and `unchanged`.
`publication: 'published'` means the revision is authorized for retrieval.
`indexing.status: 'accepted'` means mutations were acknowledged; search may still
return no new chunks or stale candidates. Only synchronous stores return `visible`.
Empty/deleted sync results omit indexing status. `remove` commits a tombstone and deletes authoritative text immediately; physical
vector cleanup is a separate `reconcile` operation.

Creation uses omitted/null `expectedRevision`; replacement/removal requires the
current token from a prior result or trusted `inspect`. CAS conflicts never silently
retry a different revision. Each changed attempt gets a fresh random revision.
Identical input with the current token skips embedding. Multiple documents in a
sync call commit individually, in order; the call is not a batch transaction.

A changed sync first atomically revokes the previous revision and stores pending
text plus a recovery journal. It then embeds/submits and publishes only after all
submissions acknowledge. Failure leaves the new revision pending and **does not
restore the old ACL or content**. `RagIndexingError` includes the revision; use
`inspect` after an ambiguous storage failure, and `reconcile(id, { revision })` to
resume after a crash. It re-embeds pending text (or a published revision with `reindex: true`) with the configured model,
so keep the embedder fixed within an embedding-model partition. Concurrent retries
of one immutable revision may duplicate upserts safely. An `AbortSignal` stops
further work; already submitted writes cannot be recalled. To cancel the revision
permanently, remove it using its token. Stale completion cannot undo a tombstone.

`reconcile` also submits obsolete-ID deletions in bounded journal pages (`limit`
1–100, default 10; pass returned `cursor` as `after`). It deliberately retains
compact retired journals and tombstones, since delayed writes can arrive after
cleanup. Repeat sweeps from the beginning after workers drain. Journal storage
grows with revision history; plan quota monitoring and offline retention. There is
no automatic proof that physical cleanup is final, and no automatic journal purge.
Retired text and ACLs are removed at replacement/deletion; only revision/count
cleanup data remains. Native administrative tools may reclaim a retired partition
once all writers are stopped and retention requirements are satisfied.

### Storage, authorization and limits

`RagVectors` contains `upsert`, `query`, `deleteByIds`, and `maxTopK`. Writes return
explicit mutation results; exceptions may mean partial or ambiguous submission.
Candidate scores are finite, nonnegative similarities. `RagPublications` provides
serializable transactions over namespace-isolated JSON values, with rollback and
strong reads. Its callback must contain storage operations only and may be retried.
No stale cache, eventually consistent KV, or replicated index can act as authority.
`memoryVectors()` and `memoryPublications()` are local, non-durable references.
Use [the Durable Object adapter and recipe](docs/vectorize.md) for native storage.

Retrieval searches once, then reads current heads, text, ACLs and requested
neighbors in one authoritative transaction. It ignores unpublished/superseded
matches and applies `rlsFilter` over caller scalar filters. The authorization
snapshot linearizes at that transaction; a response already returned cannot be
recalled. Failed authority reads reject retrieval. Stale/denied candidates can
reduce results below `topK`; there is no query pagination or automatic refill.
`importance` multiplies nonnegative similarity before `minScore` filtering.
The memory index maps cosine to `(cosine + 1) / 2` (zero-norm vectors score zero).

Namespace arguments are untrusted selectors. `resolveNamespace` authorizes them
against server identity for `sync`, `retrieve`, `remove`, `inspect`, and `reconcile`.
Inspection/reconciliation expose writer state and must require writer access.
Without a resolver, explicitly enable `allowSharedNamespace` for single-tenant
use; `requireNamespace` overrides it. `name` labels tools only; independent indexes
need different storage or server-owned namespaces. Treat source text as untrusted
reference data and enforce model-tool permissions outside the prompt.

Set `embeddingModelVersion` to a stable tag (`[A-Za-z0-9._-]`, 1–40 characters).
Change it when the model, dimensions or preprocessing changes, then re-sync into
the new partition. Old partitions require separate cleanup. ACL/metadata changes
through sync create a new revision and re-embed; this release has no ACL-only edit
API. A current server-side `rlsFilter` can revoke an identity without re-embedding.

Bounds: 100 documents per sync, 1 MiB document, 64 KiB chunk, 4,096 chunks and
4 MiB total chunk text per document, 64 KiB JSON metadata, 32 KiB query, 8,192
portable embedding dimensions, `topK` at most the adapter cap and 100, 20 neighbors
per side, and 2 MiB assembled context. Persisted records are validated before use;
corrupt publication/journal data fails closed. Adapter namespaces/IDs are opaque.

Run the local example with `pnpm --filter @velajs/ai example` after building.
See [migration instructions](docs/rag-migration.md) for the breaking store contract.

## Cloudflare managed retrieval

`createAiSearch` from `@velajs/ai/ai-search` returns `{ retrieve, asTool }` for
the native AI Search namespace binding. Construct it per verified request with
server-authorized `instanceIds` and a required `authorizeSource` callback that
checks current ACLs and publication state. The tool accepts only `{ query }`;
results contain bounded `context`, `chunks`, and `citations`.

Use immutable item keys for each content revision so current authority can reject
stale indexed content. Keep native instance management, built-in storage uploads,
indexing, and deletion on the binding. See the
[Cloudflare retrieval guide](docs/cloudflare-retrieval.md) for the native ingestion
recipe, authorization/publication requirements, limits, and the separate [Vectorize publication adapter](docs/vectorize.md).

Run the credential-free publication and revocation example after building:

```sh
node packages/ai/examples/managed-search.mjs
```

## Exports and migration from the standalone source

Core exports: `createAi`; types `Ai`, `AiProvider`, `CreateAiOptions`, `ModelInput`,
`EmbeddingModelInput`; SDK exports `generateText`, `streamText`, `embed`, `tool`,
`jsonSchema`, `LanguageModel`, `EmbeddingModel`, `Tool`.

RAG exports: `defineRag`, `memoryVectors`, `memoryPublications`, `RagIndexingError`, `fixedWindowChunks`,
`mapWithConcurrency`, `DEFAULT_SYNC_CONCURRENCY`, and the types in
[`src/rag/index.ts`](https://github.com/velajs/vela/blob/main/packages/ai/src/rag/index.ts).

The standalone source was versioned 0.1.0; npm had no published `@velajs/ai` at
migration. The monorepo starts its 1.x line and owns Changesets, catalog, lockfile,
and release checks. Intentional changes:

1. Remove `AiBinding`, `CreateAiOptions.binding`, and `Ai.run`; call native bindings
   directly, preserving provider-specific input and output types.
2. Use `provider.embeddingModel`; older provider method names are unsupported.
3. Re-sync legacy data into the new partition encoding. Old vectors are not read
   automatically. Preserve the old store until re-indexing is verified, then clean
   its legacy partitions through the adapter's own administration API.
4. Reject extra retrieval-tool input fields and include chunk/storage changes in
   re-sync detection. Public `Rag.retrieve` arguments and result shape remain intact.

Original MIT license and standalone changelog are retained. Source originates from
[`velajs/ai`](https://github.com/velajs/ai), including its tenant-boundary work.
