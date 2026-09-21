# @velajs/ai

Provider-neutral model selection and tenant-scoped retrieval for Vela applications.
Both entrypoints also work independently of Vela and Cloudflare.

- **`@velajs/ai`** supplies `createAi` to configure model defaults once per application,
  while services accept either provider model IDs or existing SDK models.
- **`@velajs/ai/rag`** supplies `defineRag` for ingestion, authorized retrieval,
  content re-sync, and request-bound AI SDK search tools over your vector store.

Use the [Vercel AI SDK](https://ai-sdk.dev) directly when your application already
owns model selection and retrieval. Vela adds no inference protocol, agent loop,
provider registry, or platform binding wrapper. `generateText`, `streamText`,
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
you use it. Neither entrypoint requires a specific provider, Vela, or Workers SDK.
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

The embedding resolver falls back to `provider.textEmbeddingModel(id)` for older
provider implementations. Missing defaults, providers, or embedding support throw
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

## Retrieval

`defineRag(config)` returns `{ sync, retrieve, remove, asTool }`. It owns chunking
and embedding; adapters receive precomputed vectors. No I/O runs at construction.

```ts
import { defineRag } from '@velajs/ai/rag';

const docs = defineRag({
  name: 'support-docs',
  vectors: myVectorStore,
  embed: async (text) => (await embed({ model: models.embeddingModel(), value: text })).embedding,
  embeddingModelVersion: 'support-embed-v1',
  resolveNamespace: ({ selector, auth, operation }) => {
    // Application functions validate trusted identity, membership and write access.
    return authorizeIndexOperation(auth, selector, operation).tenantId;
  },
  rlsFilter: (auth) => ({ team: requireIdentity(auth).team }),
});

await docs.sync([{ id: 'guide', text: manual, metadata: { team: 'support' } }], {
  auth: writerIdentity,
});
const { context, chunks, sources } = await docs.retrieve(question, {
  namespace: requestedTenantId,
  auth: verifiedIdentity,
  topK: 5,
  minScore: 0.5,
  chunkContext: { before: 1, after: 1 },
});
// Create this tool for each request; model input contains only { query }.
const search = docs.asTool({ auth: verifiedIdentity, namespace: requestedTenantId });
```

Run the credential-free tenant, tool, and re-sync example from the repository:

```sh
pnpm --filter @velajs/ai build
pnpm --filter @velajs/ai example
```

See [examples/tenant-search.mjs](examples/tenant-search.mjs). Its word-count
embedder and `memoryVectors()` are for local demonstration, not semantic search
or durable production storage.

### Adapter contract

`RagVectors` implements namespace-scoped `upsert`, `query`, `getByIds`, and
`deleteByIds`. `query` accepts a vector, `topK`, and a scalar-equality metadata
filter. `getByIds` returns records by exact IDs, omitting misses. An optional
`RagTextStore` supplies `put`, ordered `getMany`, and `remove` to keep text outside
vector metadata. Every vector/text operation must enforce its namespace.

Adapter namespaces and chunk IDs are opaque. The namespace encodes the verified
tenant (or explicit shared space) and embedding-model version without ambiguity.
Do not truncate, normalize, split, or reconstruct it. `name` only labels the tool;
use separate stores or distinct server-owned namespace prefixes for separate
indexes. Match the target database's ID/metadata limits in your adapter; the
framework's upper bounds may exceed them.

Publication requires atomic replacement of one manifest record and visibility of
all staged chunks/text before its replacement. Stores with eventual consistency
must supply those guarantees in the adapter. **Serialize `sync` and `remove` for
the same source and namespace across all writers**, for example through a queue
or a Durable Object. The generic interface has no distributed compare-and-swap;
it cannot coordinate concurrent writers in different application instances.

### Tenant and authorization boundaries

- Operation `namespace` is an untrusted selector. `resolveNamespace` verifies it
  against trusted server identity and returns the canonical, non-empty tenant
  partition. It receives `sync`, `retrieve`, or `remove` so writes can require
  stronger permissions. Never copy request JSON into `auth` as verified identity.
- Without a resolver, namespace selectors fail closed. A genuinely single-tenant
  index must explicitly set `allowSharedNamespace: true`; `requireNamespace: true`
  overrides that setting. Resolvers returning whitespace or padded names fail.
- `rlsFilter(auth)` applies to retrieval only. Its scalar metadata predicates
  override caller predicates; the helper also rechecks them locally. Missing or
  invalid identity should throw in your policy. Returning `undefined` adds no ACL.
- Source metadata applies to every chunk in that source, including neighboring
  context. Named filters in `config.filters` are conveniences, not authorization.
- `asTool` validates a bounded `{ query: string }` input, rejects extra fields,
  and takes identity/namespace only from server options. Build it per request.
- Retrieved text is untrusted data. Keep it in a data/user-context channel and
  enforce tool permissions outside the prompt. Encoded source headers provide
  attribution, not protection against instructions inside documents.

### Re-sync and embedding versions

Re-sync fingerprints use SHA-256 over text, metadata/ACLs, importance, chunk
output, text-storage mode, and the embedding-model tag. Identical input skips
embedding and writes; changing ACLs, chunking, or storage mode replaces the
source. Generation-specific IDs isolate staged text from the previous ACL. A
manifest selects the committed generation, then stale records are removed.
Rollback waits for in-flight writes. A pre-publication failure leaves the previous
source available; an ambiguous manifest-write failure invalidates its manifest
and requires re-sync. Cleanup failures surface to the caller and need retry or
adapter reconciliation. Empty chunk output removes the previous source unless
`allowEmpty: false` rejects it first.

Set `embeddingModelVersion` to a stable tag (`[A-Za-z0-9._-]`, 1–40 characters).
Change it whenever the model, dimensions, or embedding preprocessing changes,
then re-sync all documents. Old model spaces stay isolated and need separate
cleanup. An omitted tag selects an untagged space whose embedder must remain
fixed. Replacing a text-store backend with another backend also requires a fresh
partition or complete re-index; two external stores share the same storage mode.

### Ranking and limits

`retrieve` returns ranked `chunks`, deduplicated `sources`, and attributable
`context`. `importance` is a non-negative per-source score multiplier; `minScore`
applies after multiplication. Ranking adjusts only the adapter's `topK`
candidates, so request a larger candidate set when boosts matter. `chunkContext`
fetches neighbors from the same generation; use zero overlap to avoid repeated
text. `memoryVectors()` skips candidates with mismatched embedding dimensions.

Bounds: 100 documents per sync, 1 MiB per document, 64 KiB per chunk, 4,096 chunks
and 4 MiB of chunk output per document, 64 KiB source metadata, 32 KiB query,
8,192 embedding dimensions, `topK <= 100`, 20 neighbors per side, and 2 MiB assembled
context. External metadata must be bounded plain JSON. Malformed/oversized
adapter records are dropped and excess query results are sliced before inspection.

## Exports and migration from the standalone source

Core exports: `createAi`; types `Ai`, `AiProvider`, `CreateAiOptions`, `ModelInput`,
`EmbeddingModelInput`; SDK exports `generateText`, `streamText`, `embed`, `tool`,
`jsonSchema`, `LanguageModel`, `EmbeddingModel`, `Tool`.

RAG exports: `defineRag`, `memoryVectors`, `fixedWindowChunks`, `contentHash`,
`mapWithConcurrency`, `DEFAULT_SYNC_CONCURRENCY`, and the types in
[`src/rag/index.ts`](https://github.com/velajs/vela/blob/main/packages/ai/src/rag/index.ts). `contentHash` remains a non-cryptographic
FNV helper for compatibility; it is **not** the internal sync fingerprint.

The standalone source was versioned 0.1.0; npm had no published `@velajs/ai` at
migration. The monorepo starts its 1.x line and owns Changesets, catalog, lockfile,
and release checks. Intentional changes:

1. Remove `AiBinding`, `CreateAiOptions.binding`, and `Ai.run`; call native bindings
   directly, preserving provider-specific input and output types.
2. Prefer modern `provider.embeddingModel`, retaining `textEmbeddingModel` support.
3. Re-sync legacy data into the new partition encoding. Old vectors are not read
   automatically. Preserve the old store until re-indexing is verified, then clean
   its legacy partitions through the adapter's own administration API.
4. Reject extra retrieval-tool input fields and include chunk/storage changes in
   re-sync detection. Public `Rag.retrieve` arguments and result shape remain intact.

Original MIT license and standalone changelog are retained. Source originates from
[`velajs/ai`](https://github.com/velajs/ai), including its tenant-boundary work.
