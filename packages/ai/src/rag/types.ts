import type { Tool } from 'ai';

/**
 * Scope shared by public RAG operations and vector/publication-store calls. At the
 * public API, `namespace` is an untrusted selector consumed by
 * {@link RagConfig.resolveNamespace}; adapters receive an opaque partition encoding that result and the model tag.
 * At the public API, `undefined` selects explicitly enabled shared space.
 * The explicit `| undefined` is intentional — it lets a caller thread a
 * possibly-absent namespace through without tripping `exactOptionalPropertyTypes`.
 */
export interface NamespaceScope {
  namespace?: string | undefined;
}

/** Operations for which a trusted namespace must be resolved. */
export type RagNamespaceOperation = 'sync' | 'retrieve' | 'remove' | 'inspect' | 'reconcile';

/**
 * Input to {@link RagConfig.resolveNamespace}. `selector` is request-controlled
 * and must never be trusted on its own; the resolver derives (or authorizes) the
 * actual storage namespace from server-trusted `auth` state.
 */
export interface RagNamespaceResolution {
  operation: RagNamespaceOperation;
  selector?: string | undefined;
  auth?: unknown;
}

/** Resolve the namespace used at the vector/publication-store boundary. */
export type RagNamespaceResolver = (
  input: RagNamespaceResolution,
) => Promise<string | undefined> | string | undefined;

/**
 * `(text) => vector`. The RAG helper owns embedding: it calls this to turn chunk
 * text (on `sync`) and the query (on `retrieve`) into a vector, then hands the
 * precomputed vector to the {@link RagVectors} store. Sync or async.
 */
export type RagEmbedder = (text: string) => Promise<ReadonlyArray<number>> | ReadonlyArray<number>;

/** Immutable revision-specific embedding. Application data stays in publications. */
export interface RagVectorRecord {
  id: string;
  vector: ReadonlyArray<number>;
}
/** Untrusted ranked candidate. Scores must be finite and nonnegative; higher means closer. */
export interface RagVectorMatch {
  id: string;
  score: number;
}
export interface RagVectorQuery extends NamespaceScope {
  vector: ReadonlyArray<number>;
  topK: number;
}
/**
 * Namespace-isolated candidate index. Mutations may be eventual and may throw
 * after partial/ambiguous submission. Repeated upserts of one ID must be safe.
 * No publication, authorization, hydration, filtering or pagination is implied.
 */
export interface RagVectors {
  upsert(
    records: ReadonlyArray<RagVectorRecord>,
    scope: NamespaceScope,
  ): Promise<RagIndexingResult>;
  query(query: RagVectorQuery): Promise<ReadonlyArray<RagVectorMatch>>;
  deleteByIds(ids: ReadonlyArray<string>, scope: NamespaceScope): Promise<RagIndexingResult>;
  readonly maxTopK: number;
}

/** A mutation acknowledgment, separate from authoritative publication. */
export interface RagIndexingResult {
  /** `visible` is reserved for synchronously queryable stores. */
  status: 'visible' | 'accepted';
  mutationIds: ReadonlyArray<string>;
}

/** Serializable, rollback-on-error transaction over detached JSON values. */
export interface RagPublicationTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Lexicographic, exclusive cursor. Return at most limit entries. */
  list<T>(options: {
    prefix: string;
    after?: string | undefined;
    limit: number;
  }): Promise<Map<string, T>>;
}

/**
 * Trusted authority for revisions, ACL metadata, text and recovery journals.
 * Transactions must be serializable across ALL writers and readers of a scope,
 * persist atomically, roll back on error, and never read stale replicas/caches.
 * Callbacks may be retried: no network/index side effects inside them.
 * The store must isolate namespaces and return detached values.
 */
export interface RagPublications {
  transaction<T>(
    scope: NamespaceScope,
    body: (tx: RagPublicationTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface RagPublication {
  sourceId: string;
  revision: string;
  state: 'pending' | 'published' | 'deleted';
  chunks: number;
  hash: string;
  importance: number;
  metadata?: Record<string, unknown>;
  /** Missing until every index submission is acknowledged. */
  indexing?: RagIndexingResult;
}

export interface ReconcileOptions extends NamespaceScope {
  auth?: unknown;
  /** Required ownership token. Superseded attempts cannot resume. */
  revision: string;
  signal?: AbortSignal;
  /** Also resubmit a published revision; default only resumes pending work. */
  reindex?: boolean;
  /** Retired revision journal page, exclusive cursor; default page size 10. */
  after?: string;
  limit?: number;
}

export interface ReconcileResult {
  publication: RagPublication;
  /** Cleanup submission acknowledgments; journals remain for later sweeps. */
  cleanup: ReadonlyArray<RagIndexingResult>;
  /** Supply to another reconcile call; absent at the end of this journal scan. */
  cursor?: string;
}

/**
 * A pre-defined, reusable metadata filter, declared on {@link RagConfig.filters}
 * and referenced by name from {@link RetrieveOptions.filter} — so the same
 * tenant/RBAC predicate is not re-typed at every retrieval site. Passing an
 * unregistered name throws at call time.
 */
export interface RagNamedFilter {
  filter: Record<string, unknown>;
  /** Optional human-readable description for observability. */
  description?: string;
}

export interface RagConfig {
  /** The vector-store seam (bring your own). */
  vectors: RagVectors;
  /** Turns text into a vector; the helper embeds chunks and queries through it. */
  embed: RagEmbedder;
  /** Required authoritative publication/text store, independent of the index. */
  publications: RagPublications;

  /**
   * A human label for this index, used only in
   * the default tool description; it does not partition stored data. Defaults to `'default'`.
   */
  name?: string;

  /** Target chunk size in characters. Default 1000. */
  chunkSize?: number;
  /** Overlap in characters between adjacent chunks. Default 200. Must be < `chunkSize`. */
  chunkOverlap?: number;
  /**
   * Custom chunker; overrides the built-in fixed-window splitter. Output is
   * bounded to 4,096 chunks, 64 KiB each, and 4 MiB in aggregate per document.
   */
  chunk?: (text: string) => ReadonlyArray<string>;

  /** Default candidate depth. Default 5; bounded by maxTopK and 100. */
  topK?: number;

  /**
   * Resolve the storage namespace from trusted server identity. Per-operation
   * `namespace` values are selectors only: when one is supplied, this resolver
   * must verify membership before returning the actual namespace. A partitioned
   * index fails closed when this resolver is absent.
   *
   * @example
   * ```ts
   * resolveNamespace: ({ selector, auth }) => {
   *   const identity = requireAccessIdentity(auth);
   *   return requireTenantMembership(identity, selector).tenantId;
   * }
   * ```
   */
  resolveNamespace?: RagNamespaceResolver;

  /**
   * Fail closed when {@link RagConfig.resolveNamespace} does not return a
   * namespace: `sync`/`retrieve`/`remove` throw rather than touching shared
   * space. The default already behaves this way; this option also overrides an
   * accidental `allowSharedNamespace: true` combination.
   */
  requireNamespace?: boolean;

  /**
   * Explicitly allow the shared namespace. Required for genuinely single-tenant
   * indexes; otherwise a non-empty namespace is mandatory.
   */
  allowSharedNamespace?: boolean;

  /**
   * An opt-in embedding-model version tag that partitions the vector space, so a
   * model swap can never silently mix incompatible vector spaces (querying one
   * model's vectors with another model's query returns meaningless neighbours).
   * When set, it is folded into the effective namespace of
   * every operation, so bumping it cleanly re-partitions: old vectors become
   * unreachable to new queries until sources are re-synced under the new tag.
   * Omitting it selects an untagged partition; keep its embedder fixed.
   * Must match `^[A-Za-z0-9._-]{1,40}$`.
   */
  embeddingModelVersion?: string;

  /** Named, reusable filter expressions referenced by {@link RetrieveOptions.filter}. */
  filters?: Record<string, RagNamedFilter>;

  /**
   * Row-level-security filter derived from the retrieval identity. Called once
   * per `retrieve()` with {@link RetrieveOptions.auth}; the returned metadata
   * filter is merged **over** the caller's filter — RLS keys win — so a caller
   * can never widen past what RLS allows. Return `undefined` to add no
   * constraint. Runs on retrieval only; indexing is a trusted server path.
   */
  rlsFilter?: (
    auth: unknown,
  ) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
}

/** One document handed to {@link Rag.sync}. */
export interface RagDocument {
  /** Stable source id; chunk ids derive from it. Re-syncing the same id replaces it. */
  id: string;
  /** Compare-and-swap token. Omitted/null means create only; replacements require the current revision. */
  expectedRevision?: string | null;
  /** The document body to chunk, embed, and upsert. */
  text: string;
  /** Authoritative metadata shared by every chunk of this document (e.g. title, url). */
  metadata?: Record<string, unknown>;
  /**
   * A non-negative multiplier applied to this document's match scores at
   * retrieval time (default 1). `> 1` boosts a canonical source above incidental
   * ones; `< 1` demotes it.
   */
  importance?: number;
}

export interface SyncOptions extends NamespaceScope {
  /** Stops further submissions; already submitted mutations cannot be recalled. Pending work remains resumable. */
  signal?: AbortSignal;
  /** Trusted server identity/context consumed by {@link RagConfig.resolveNamespace}. */
  auth?: unknown;
  /**
   * When `false`, throw if a document produces zero chunks (empty or
   * whitespace-only text). Default `true` (an empty document removes any previously stored source).
   */
  allowEmpty?: boolean;
  /** Fired for each chunk after authoritative publication commits. */
  onChunk?: (info: {
    sourceId: string;
    chunkIndex: number;
    id: string;
    text: string;
    total: number;
  }) => void;
}

export interface SyncResult {
  id: string;
  revision: string;
  /** Publication authorizes retrieval; it does not promise index visibility. */
  publication: 'published' | 'deleted';
  /** Absent for an empty/deleted publication; cleanup is a separate operation. */
  indexing?: RagIndexingResult;
  /** Number of chunks the document is now stored as. */
  chunks: number;
  /** The deterministic chunk ids, in order. */
  ids: ReadonlyArray<string>;
  /** True when the content hash matched the last sync — embedding and writes were skipped. */
  unchanged: boolean;
}

export interface RetrieveOptions extends NamespaceScope {
  topK?: number;
  /** Drop matches whose (importance-adjusted) score is below this threshold. */
  minScore?: number;
  /** A literal metadata filter, or the name of one declared in {@link RagConfig.filters}. */
  filter?: Record<string, unknown> | string;
  /**
   * Also stitch this many neighbouring chunks around each match into its text,
   * fetched by deterministic id (not re-queried) — "embed small, retrieve big".
   * Best paired with `chunkOverlap: 0`.
   */
  chunkContext?: { before?: number; after?: number };
  /**
   * The retrieval identity handed to {@link RagConfig.rlsFilter}. Opaque here so
   * `@velajs/ai` stays decoupled from any identity type; the `rlsFilter` narrows it.
   */
  auth?: unknown;
  /** Fires after ranking and bounded context expansion, for observability. */
  onRetrieve?: (info: { query: string; matches: number }) => void;
}

/** Trusted scope for publication inspection. */
export interface InspectOptions extends NamespaceScope {
  auth?: unknown;
}

/** Options for deleting a source from a trusted namespace. */
export interface RemoveOptions extends InspectOptions {
  /** Compare-and-swap token. Omitted/null means the source must not yet exist. */
  expectedRevision?: string | null;
  /** Trusted server identity/context consumed by {@link RagConfig.resolveNamespace}. */
  auth?: unknown;
}

export interface RetrievedChunk {
  id: string;
  sourceId: string;
  chunkIndex: number;
  text: string;
  /** Similarity score, multiplied by the source's `importance` weight. */
  score: number;
  /** The source-level importance weight folded into `score` (1 if none was set). */
  importance: number;
  /** Current authoritative source metadata. */
  metadata?: Record<string, unknown>;
}

export interface RagSource {
  id: string;
  /** The source's importance weight (default 1), propagated for downstream ranking. */
  weight: number;
  /** Current authoritative source metadata. */
  metadata?: Record<string, unknown>;
}

/** The shape returned by {@link Rag.retrieve}; consumable directly as agent memory. */
export interface RetrieveResult {
  /** Prompt-ready context: chunks joined under `[source:<id>#<n>]` headers. */
  context: string;
  /** Ranked chunks, best first. */
  chunks: ReadonlyArray<RetrievedChunk>;
  /** Deduped source references, in best-first order. */
  sources: ReadonlyArray<RagSource>;
}

/** Tool scope; inherited `namespace` is an untrusted selector verified by the resolver. */
export interface RagToolOptions extends NamespaceScope {
  /** Tool description shown to the model. Defaults to a search description naming the index. */
  description?: string;
  /** Retrieval depth for tool-invoked retrievals. */
  topK?: number;
  /** The retrieval identity passed to {@link RagConfig.rlsFilter} for tool-invoked retrievals. */
  auth?: unknown;
}

/** The RAG surface returned by {@link defineRag}. */
export interface Rag {
  /**
   * Chunk → embed → upsert each document. Re-syncing a document id replaces it:
   * the expected revision must match; unchanged inputs skip re-embedding.
   * Changed input revokes old content before indexing. Reconcile cleans obsolete vectors.
   */
  sync: (
    docs: ReadonlyArray<RagDocument>,
    options?: SyncOptions,
  ) => Promise<ReadonlyArray<SyncResult>>;
  /** Embed the query and return ranked chunks plus prompt-ready context. */
  retrieve: (query: string, options?: RetrieveOptions) => Promise<RetrieveResult>;
  /** Delete every chunk of a previously synced source. */
  remove: (id: string, options?: RemoveOptions) => Promise<RagPublication>;
  /** Trusted writer API; includes ACL metadata. Do not expose directly to readers. */
  inspect: (id: string, options?: InspectOptions) => Promise<RagPublication | undefined>;
  /** Resume pending/current indexing and submit a bounded page of obsolete-ID deletions. */
  reconcile: (id: string, options: ReconcileOptions) => Promise<ReconcileResult>;
  /**
   * Expose `retrieve` as an AI SDK tool (for a `generateText`/`streamText`
   * `tools` map) so a model can search the index itself.
   */
  asTool: (options?: RagToolOptions) => Tool<{ query: string }, RetrieveResult>;
}
