import type { Tool } from 'ai';

/**
 * Scope shared by public RAG operations and vector/text-store calls. At the
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
export type RagNamespaceOperation = 'sync' | 'retrieve' | 'remove';

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

/** Resolve the namespace used at the vector/text-store boundary. */
export type RagNamespaceResolver = (
  input: RagNamespaceResolution,
) => Promise<string | undefined> | string | undefined;

/**
 * `(text) => vector`. The RAG helper owns embedding: it calls this to turn chunk
 * text (on `sync`) and the query (on `retrieve`) into a vector, then hands the
 * precomputed vector to the {@link RagVectors} store. Sync or async.
 */
export type RagEmbedder = (text: string) => Promise<ReadonlyArray<number>> | ReadonlyArray<number>;

/** A vector to write, with its id and optional metadata. */
export interface RagVectorRecord {
  id: string;
  vector: ReadonlyArray<number>;
  metadata?: Record<string, unknown>;
}

/** One ranked hit from {@link RagVectors.query}. */
export interface RagVectorMatch {
  id: string;
  /** Similarity score; higher is better. */
  score: number;
  metadata?: Record<string, unknown>;
}

/** A record fetched by id from {@link RagVectors.getByIds} (no vector, just metadata). */
export interface RagStoredVector {
  id: string;
  metadata?: Record<string, unknown>;
}

export interface RagVectorQuery {
  /** The precomputed query vector (the helper embeds the query text for you). */
  vector: ReadonlyArray<number>;
  topK: number;
  namespace?: string | undefined;
  /** Metadata equality predicate; a match must satisfy every key. */
  filter?: Record<string, unknown> | undefined;
  /**
   * How much stored metadata to return on matches. `'all'` is required for
   * metadata-mode retrieval (chunk text lives in metadata); `'indexed'` suffices
   * when a {@link RagTextStore} holds the text.
   */
  returnMetadata?: 'all' | 'indexed' | 'none' | undefined;
}

/**
 * The pluggable vector-store seam. Bring your own — any store that can hold
 * precomputed vectors keyed by id, scoped by namespace, satisfies it. The RAG
 * helper never imports a concrete store; a Cloudflare Vectorize adapter, an
 * in-memory store ({@link memoryVectors}), pgvector, and so on all plug in here.
 *
 * Every method is **namespace-scoped**: a query in one namespace must never see
 * another namespace's vectors. That is the load-bearing tenant-isolation
 * boundary — enforce it in your adapter.
 */
export interface RagVectors {
  /** Insert or replace vectors by id within a namespace. */
  upsert: (records: ReadonlyArray<RagVectorRecord>, options: NamespaceScope) => Promise<void>;
  /** Rank stored vectors against a query vector, honouring `filter` and `namespace`. */
  query: (query: RagVectorQuery) => Promise<ReadonlyArray<RagVectorMatch>>;
  /**
   * Fetch records by exact id (metadata only). Used for content-hash re-sync
   * reads, `chunkContext` neighbour lookups, and metadata-mode text hydration.
   * Missing ids are simply absent from the result.
   */
  getByIds: (
    ids: ReadonlyArray<string>,
    options: NamespaceScope,
  ) => Promise<ReadonlyArray<RagStoredVector>>;
  /** Delete vectors by id within a namespace. */
  deleteByIds: (ids: ReadonlyArray<string>, options: NamespaceScope) => Promise<void>;
}

/** A chunk handed to {@link RagTextStore.put}. */
export interface RagStoredChunk {
  id: string;
  sourceId: string;
  chunkIndex: number;
  text: string;
}

/**
 * Optional chunk-text storage. Without it, chunk text is stored inline in vector
 * metadata (metadata mode). Supplying a store (a KV namespace, a SQL table, …)
 * moves text out of the vector metadata: `sync` writes text here and `retrieve`
 * hydrates it back by chunk id. Must be idempotent by chunk `id`.
 */
export interface RagTextStore {
  put: (chunks: ReadonlyArray<RagStoredChunk>, options: NamespaceScope) => Promise<void>;
  /** Fetch chunk texts by id, aligned to the input order; `undefined` for misses. */
  getMany: (
    ids: ReadonlyArray<string>,
    options: NamespaceScope,
  ) => Promise<ReadonlyArray<string | undefined>>;
  /**
   * Remove chunk texts by id. Required so a failed ACL/content replacement can
   * roll back staged text instead of leaving it readable through old vectors.
   */
  remove: (ids: ReadonlyArray<string>, options: NamespaceScope) => Promise<void>;
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
  /** Optional chunk-text storage; without it text is stored in vector metadata. */
  textStore?: RagTextStore;

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

  /** Default retrieval depth. Default 5; maximum 100. */
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
   * When set, it is folded into the effective namespace (and chunk-id prefix) of
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
  /** The document body to chunk, embed, and upsert. */
  text: string;
  /** Metadata copied onto every chunk of this document (e.g. title, url). */
  metadata?: Record<string, unknown>;
  /**
   * A non-negative multiplier applied to this document's match scores at
   * retrieval time (default 1). `> 1` boosts a canonical source above incidental
   * ones; `< 1` demotes it.
   */
  importance?: number;
}

export interface SyncOptions extends NamespaceScope {
  /** Trusted server identity/context consumed by {@link RagConfig.resolveNamespace}. */
  auth?: unknown;
  /**
   * When `false`, throw if a document produces zero chunks (empty or
   * whitespace-only text). Default `true` (an empty document removes any previously stored source).
   */
  allowEmpty?: boolean;
  /** Progress callback fired after each chunk is upserted. */
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
  /** Fires after ranking, before chunk-context expansion — for observability. */
  onRetrieve?: (info: { query: string; matches: number }) => void;
}

/** Options for deleting a source from a trusted namespace. */
export interface RemoveOptions extends NamespaceScope {
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
  /** Caller metadata stored on the chunk (internal keys stripped). */
  metadata?: Record<string, unknown>;
}

export interface RagSource {
  id: string;
  /** The source's importance weight (default 1), propagated for downstream ranking. */
  weight: number;
  /** Caller metadata from the source's best-ranked chunk (internal keys stripped). */
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
   * unchanged text, metadata, chunk output and storage mode skip re-embedding, and stale
   * trailing chunks from a shrunk document are deleted automatically.
   */
  sync: (
    docs: ReadonlyArray<RagDocument>,
    options?: SyncOptions,
  ) => Promise<ReadonlyArray<SyncResult>>;
  /** Embed the query and return ranked chunks plus prompt-ready context. */
  retrieve: (query: string, options?: RetrieveOptions) => Promise<RetrieveResult>;
  /** Delete every chunk of a previously synced source. */
  remove: (id: string, options?: RemoveOptions) => Promise<void>;
  /**
   * Expose `retrieve` as an AI SDK tool (for a `generateText`/`streamText`
   * `tools` map) so a model can search the index itself.
   */
  asTool: (options?: RagToolOptions) => Tool<{ query: string }, RetrieveResult>;
}
