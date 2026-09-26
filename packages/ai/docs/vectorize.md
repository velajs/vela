# Vectorize and authoritative RAG publication

`@velajs/ai/vectorize` exports `vectorizeVectors(binding, { dimensions, metric })`
and `durableObjectPublications(storage)`. Both are optional; the base and `/rag`
entrypoints use Web APIs and have no native module imports.

```ts
import { defineRag } from '@velajs/ai/rag';
import { vectorizeVectors, durableObjectPublications } from '@velajs/ai/vectorize';

const vectors = vectorizeVectors(env.INDEX, { dimensions: 768, metric: 'cosine' });
const rag = defineRag({
  vectors,
  publications: durableObjectPublications(this.ctx.storage),
  embed: embedText,
  embeddingModelVersion: 'embed-v1',
  resolveNamespace: ({ auth, selector, operation }) => authorize(auth, selector, operation),
});
// Original native binding, including describe(), remains available.
const diagnostics = await vectors.binding.describe();
```

The [compilable native recipe](../examples/vectorize-documents.ts) runs all index
operations through one stable Durable Object, uses its real transactional storage,
and uses Workers AI embeddings. Bind `INDEX` to a pre-existing 768-dimensional
cosine Vectorize V2 index, `AI` to Workers AI, and `PUBLICATIONS` to the recipe's
`Documents` SQLite Durable Object class. Export the class from the Worker entry
and configure a SQLite migration in the consuming app. This repository's local
fixture is not a deployment configuration. Authenticate outside the object, create
`Identity` on the server, and never expose arbitrary RPC method forwarding.

All access must use the same authority object and index binding. For larger
workloads, shard authority objects by a stable, server-owned tenant mapping and
keep every operation for that tenant on its shard; changing the mapping requires
migration. The adapter cannot coordinate two unrelated DOs pointed at the same
logical scope. It splits JSON records into 8,192-character parts (well below native
128 KiB value limits, even after escaping) within one transaction. Logical keys
are capped at 1,024 UTF-8 bytes before adding bounded prefixes. Heads and journals
stay small; document text is stored per chunk. Failed transactions roll back and
retained transaction handles close. See the [storage limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

## Native behavior and adapter choices

The [Vectorize API](https://developers.cloudflare.com/vectorize/reference/client-api/)
returns asynchronous mutation IDs. Current [Workers types](https://github.com/cloudflare/workerd/tree/main/types)
describe the processed-up-to marker but do not provide a per-query distributed
visibility barrier. The published numeric marker types also differ from UUID/date
examples in the docs; the structural adapter leaves these diagnostic fields
`unknown`. Mutation UUIDs cannot be compared lexicographically for order.
Neither a receipt, a readable ID, nor equality with the latest marker promotes
`accepted` to `visible`. No polling is hidden inside sync or reconcile.

The adapter's choices follow the [native limits](https://developers.cloudflare.com/vectorize/platform/limits/):

- SHA-256 domain-separated JSON tuples map full logical namespace and full
  namespace/ID pairs to separate 64-byte hex digests. Undefined shared space is
  distinct from every tenant. There is no truncation. Security assumes SHA-256
  collision resistance; this is not a registry proving mathematical uniqueness.
- Native get/delete receive only physical IDs. The adapter never passes a logical
  ID directly. Its additional `getByIds` convenience checks the returned physical
  digest, namespace, and reverse metadata; it is not part of `RagVectors` and is
  never used as authority or as a readiness probe. Writers must exclusively own
  the adapter's physical ID space; bypassing it with native mutations can corrupt
  the index. RAG authority still rejects foreign/stale IDs.
- Vector metadata contains only reverse-ID and partition bookkeeping. The complete
  UTF-8 JSON payload is checked against 10 KiB, including escaping. No text or ACL
  metadata is copied to the index. Logical IDs/namespaces are bounded at 4,096
  UTF-8 bytes; exceptionally escape-heavy IDs may hit the metadata limit earlier.
- Dimensions must match the pre-existing index, from 1 to 1,536. Values must be
  finite float32-representable numbers. Describe can verify dimensions, but the
  configured metric must be supplied correctly by the operator.
- Upserts batch at 1,000; by-ID operations use conservative batches of 100. Each
  public batch is fully validated before its first submission. A later error may
  leave earlier batches accepted; retry/reconcile is required.
- Query requires all reverse metadata and therefore exposes `maxTopK: 50`.
  Larger requests throw, never silently clamp. Query has no continuation cursor.
  RAG applies scalar filters against authority after candidate selection, which
  can reduce recall. Native [metadata filters](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/)
  remain available through `binding`; their indexes, 64-byte indexed strings and
  less-than-2,048-byte predicate limit do not become authorization guarantees.
- Scores are nonnegative similarity: cosine `(score + 1) / 2` clamped to `[0,1]`,
  Euclidean `1 / (1 + distance)`, and dot-product stable softplus
  `max(score,0) + log1p(exp(-abs(score)))`. These monotonic mappings let positive
  importance boost matches consistently. Thresholds refer to transformed scores.

Namespaces remain subject to account quotas (including model-version partitions).
Native [list-vectors pagination](https://developers.cloudflare.com/vectorize/best-practices/list-vectors/)
is an administrative snapshot with expiring cursors, not pagination of ranked
query results. Cleanup uses authoritative revision journals rather than scans of
search results. No cross-mutation arrival/replica ordering is assumed, including
upserts that arrive after an earlier cleanup delete.

## Verification and optional live acceptance

Local tests cover controlled stale/reordered search responses, partially accepted
writes, CAS conflicts, canceled retries and real workerd Durable Object storage.
They do not establish Cloudflare's global query visibility. The native binding's
structural compatibility is checked against the workspace Workers types.

For explicitly supplied **pre-existing synthetic** resources, build then run:

```sh
VELA_VECTORIZE_LIVE=1 \
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<scoped-vectorize-read-write-token> \
VELA_VECTORIZE_INDEX=vela-synthetic-acceptance \
VELA_VECTORIZE_METRIC=cosine \
pnpm --filter @velajs/ai test:vectorize:live
```

The fixture uses the official REST API through the same adapter contract, a unique
synthetic namespace, deterministic embeddings, and in-process authority. It creates
no resources, deploys no Worker, and provisions no Durable Object. It observes an
actual initial query before checking isolation, ACL replacement and tombstoning.
The native Durable Object lifecycle is covered separately by workerd tests.

Polling is capped at 120 seconds with 10-second individual HTTP deadlines, followed
by an independent 60-second cleanup budget. IDs are recorded before every submission;
cleanup deletes only those IDs and observes by-ID absence. That observation cannot
exclude stale query replicas or later-arriving writes. A failed or killed process
can leave synthetic records; inspect the dedicated synthetic index before reusing
it. A successful sample cannot prove global visibility, production latency bounds,
provider mutation ordering, or exhaustive recall. Credentials/resources are not
implicitly discovered and the live command fails closed unless explicitly enabled.
