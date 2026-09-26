import { jsonSchema, tool } from 'ai';
import type { Tool } from 'ai';

import { fixedWindowChunks } from './chunk';
import { DEFAULT_SYNC_CONCURRENCY, mapWithConcurrency } from './concurrent';
import type {
  RemoveOptions,
  InspectOptions,
  Rag,
  RagConfig,
  RagDocument,
  RagVectorMatch,
  RetrievedChunk,
  RetrieveOptions,
  RetrieveResult,
  RagSource,
  RagToolOptions,
  SyncOptions,
  SyncResult,
  RagPublication,
  RagPublicationTransaction,
  RagIndexingResult,
  ReconcileOptions,
  ReconcileResult,
} from './types';

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 100;
const MAX_CHUNK_CONTEXT = 20;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_QUERY_BYTES = 32 * 1024;
const MAX_DOCUMENTS_PER_SYNC = 100;
const MAX_CHUNKS_PER_DOCUMENT = 4096;
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_TOTAL_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
const MAX_VECTOR_DIMENSIONS = 8192;
const MAX_NAMESPACE_BYTES = 512;
const MAX_SOURCE_ID_BYTES = 512;
const MAX_ADAPTER_ID_BYTES = 4096;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 4096;
const MAX_JSON_KEYS = 1024;

const textEncoder = new TextEncoder();
const bytes = (value: string): number => textEncoder.encode(value).byteLength;

/** `^[A-Za-z0-9._-]{1,40}$` — the shape allowed for {@link RagConfig.embeddingModelVersion}. */
const MODEL_VERSION_PATTERN = /^[\w.-]{1,40}$/;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

type MetadataResult =
  | { readonly valid: true; readonly value: Record<string, unknown> | undefined }
  | { readonly valid: false };

/** Validate, bound, and detach metadata received from a caller or adapter. */
const boundedMetadata = (value: unknown, maxBytes: number): MetadataResult => {
  if (value === undefined) return { valid: true, value: undefined };
  if (!isPlainRecord(value)) return { valid: false };

  try {
    const canonical = canonicalJson(value, { maxBytes });
    const parsed: unknown = JSON.parse(canonical);
    return isPlainRecord(parsed) ? { valid: true, value: parsed } : { valid: false };
  } catch {
    return { valid: false };
  }
};

const requireCallerMetadata = (
  value: unknown,
  sourceId: string,
): Record<string, unknown> | undefined => {
  const result = boundedMetadata(value, MAX_METADATA_BYTES);
  if (!result.valid) {
    throw new Error(
      `@velajs/ai/rag: metadata for source "${sourceId}" must be bounded plain JSON (${MAX_METADATA_BYTES} bytes maximum)`,
    );
  }
  return result.value;
};

const metadataMatchesFilter = (
  metadata: Record<string, unknown> | undefined,
  filter: Record<string, unknown>,
): boolean => {
  if (Object.keys(filter).length === 0) return true;
  if (metadata === undefined) return false;
  for (const [key, expected] of Object.entries(filter)) {
    if (!Object.hasOwn(metadata, key) || !Object.is(metadata[key], expected)) return false;
  }
  return true;
};

/** Bound and validate the runtime output of an untrusted vector adapter. */
const boundedVectorMatches = (value: unknown, topK: number): RagVectorMatch[] => {
  let candidates: ReadonlyArray<unknown>;
  try {
    if (!Array.isArray(value)) return [];
    candidates = value;
  } catch {
    return [];
  }
  let inspected: ReadonlyArray<unknown>;
  try {
    inspected = candidates.slice(0, topK);
  } catch {
    return [];
  }
  const accepted: RagVectorMatch[] = [];
  const seen = new Set<string>();

  // The adapter contract already receives topK. Slice before validation so an
  // over-returning adapter cannot make filtering an unbounded CPU operation.
  for (const candidate of inspected) {
    if (!isPlainRecord(candidate)) continue;
    const idDescriptor = Object.getOwnPropertyDescriptor(candidate, 'id');
    const scoreDescriptor = Object.getOwnPropertyDescriptor(candidate, 'score');
    if (
      idDescriptor === undefined ||
      !('value' in idDescriptor) ||
      scoreDescriptor === undefined ||
      !('value' in scoreDescriptor)
    ) {
      continue;
    }
    const id = idDescriptor.value;
    const score = scoreDescriptor.value;
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      bytes(id) > MAX_ADAPTER_ID_BYTES ||
      seen.has(id) ||
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score < 0
    ) {
      continue;
    }
    accepted.push({ id, score });
    seen.add(id);
  }

  return accepted;
};

/** Tools accept only a bounded query; identity and namespace are server-owned. */
const parseToolInput = (input: unknown): { query: string } => {
  if (isPlainRecord(input) && Object.keys(input).length === 1) {
    const query = Object.getOwnPropertyDescriptor(input, 'query');
    if (
      query &&
      'value' in query &&
      typeof query.value === 'string' &&
      bytes(query.value) <= MAX_QUERY_BYTES
    ) {
      return { query: query.value };
    }
  }
  throw new Error('@velajs/ai/rag: tool input must contain only a bounded string query');
};

const foldModelVersion = (namespace: string | undefined, tag: string | undefined): string =>
  JSON.stringify(['rag-v2', namespace ?? null, tag ?? null]);

interface PublicationChunk {
  id: string;
  key: string;
  sourceId: string;
  revision: string;
  chunkIndex: number;
  text: string;
}
interface PublicationJournal {
  revision: string;
  chunks: number;
}
const isRevision = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const storedObject = (value: unknown): Record<string, unknown> => {
  try {
    if (!isPlainRecord(value)) throw new Error('record required');
    const decoded: unknown = JSON.parse(
      canonicalJson(value, {
        maxBytes: 1024 * 1024,
        maxDepth: MAX_JSON_DEPTH + 3,
        maxNodes: MAX_JSON_NODES + MAX_CHUNKS_PER_DOCUMENT + 32,
        maxKeys: MAX_CHUNKS_PER_DOCUMENT,
      }),
    );
    if (!isPlainRecord(decoded)) throw new Error('record required');
    return decoded;
  } catch {
    throw new Error('@velajs/ai/rag: corrupt publication record');
  }
};
const parseIndexing = (value: unknown): RagIndexingResult => {
  const record = storedObject(value);
  if (
    (record.status !== 'visible' && record.status !== 'accepted') ||
    !Array.isArray(record.mutationIds) ||
    record.mutationIds.length > MAX_CHUNKS_PER_DOCUMENT ||
    record.mutationIds.some((id) => typeof id !== 'string' || bytes(id) > 128)
  )
    throw new Error('@velajs/ai/rag: corrupt indexing receipt');
  return { status: record.status, mutationIds: record.mutationIds };
};
const parsePublication = (value: unknown): RagPublication | undefined => {
  if (value === undefined) return undefined;
  const record = storedObject(value);
  if (
    typeof record.sourceId !== 'string' ||
    !record.sourceId.isWellFormed() ||
    !record.sourceId.trim() ||
    bytes(record.sourceId) > MAX_SOURCE_ID_BYTES ||
    !isRevision(record.revision) ||
    !['pending', 'published', 'deleted'].includes(String(record.state)) ||
    typeof record.chunks !== 'number' ||
    !Number.isInteger(record.chunks) ||
    record.chunks < 0 ||
    record.chunks > MAX_CHUNKS_PER_DOCUMENT ||
    typeof record.hash !== 'string' ||
    (record.hash !== '' && !/^[a-f0-9]{64}$/.test(record.hash)) ||
    typeof record.importance !== 'number' ||
    !Number.isFinite(record.importance) ||
    record.importance < 0
  )
    throw new Error('@velajs/ai/rag: corrupt publication head');
  const metadata = requireCallerMetadata(record.metadata, record.sourceId);
  return {
    sourceId: record.sourceId,
    revision: record.revision,
    state: record.state as RagPublication['state'],
    chunks: record.chunks,
    hash: record.hash,
    importance: record.importance,
    ...(metadata === undefined ? {} : { metadata }),
    ...(record.indexing === undefined ? {} : { indexing: parseIndexing(record.indexing) }),
  };
};
const parseChunk = (value: unknown): PublicationChunk | undefined => {
  if (value === undefined) return undefined;
  const record = storedObject(value);
  if (
    typeof record.key !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.key) ||
    !isRevision(record.revision) ||
    typeof record.chunkIndex !== 'number' ||
    !Number.isInteger(record.chunkIndex) ||
    record.chunkIndex < 0 ||
    record.chunkIndex >= MAX_CHUNKS_PER_DOCUMENT ||
    record.id !== `${record.key}:${record.revision}:${record.chunkIndex}` ||
    typeof record.text !== 'string' ||
    bytes(record.text) > MAX_CHUNK_BYTES ||
    typeof record.sourceId !== 'string' ||
    !record.sourceId.isWellFormed() ||
    bytes(record.sourceId) > MAX_SOURCE_ID_BYTES
  )
    throw new Error('@velajs/ai/rag: corrupt publication chunk');
  return {
    id: record.id,
    key: record.key,
    sourceId: record.sourceId,
    revision: record.revision,
    chunkIndex: record.chunkIndex,
    text: record.text,
  };
};
const parseJournal = (value: unknown): PublicationJournal => {
  const record = storedObject(value);
  if (
    !isRevision(record.revision) ||
    typeof record.chunks !== 'number' ||
    !Number.isInteger(record.chunks) ||
    record.chunks < 0 ||
    record.chunks > MAX_CHUNKS_PER_DOCUMENT
  )
    throw new Error('@velajs/ai/rag: corrupt publication journal');
  return { revision: record.revision, chunks: record.chunks };
};
const sourceDigest = async (sourceId: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(sourceId));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
const getPublication = async (
  tx: RagPublicationTransaction,
  key: string,
): Promise<RagPublication | undefined> => {
  const head = parsePublication(await tx.get<unknown>(key));
  if (head && key !== `h:${await sourceDigest(head.sourceId)}`)
    throw new Error('@velajs/ai/rag: corrupt publication source key');
  return head;
};
const getChunk = async (
  tx: RagPublicationTransaction,
  key: string,
  sourceId?: string,
): Promise<PublicationChunk | undefined> => {
  const chunk = parseChunk(await tx.get<unknown>(key));
  if (
    chunk &&
    (key !== `c:${chunk.id}` ||
      chunk.key !== (await sourceDigest(chunk.sourceId)) ||
      (sourceId !== undefined && sourceId !== chunk.sourceId))
  )
    throw new Error('@velajs/ai/rag: corrupt chunk identity at publication key');
  return chunk;
};

/** Failed submissions may already have reached the index. Resume by revision. */
export class RagIndexingError extends Error {
  constructor(
    readonly sourceId: string,
    readonly revision: string,
    cause: unknown,
  ) {
    super(
      `@velajs/ai/rag: indexing ${sourceId} (${revision}) failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'RagIndexingError';
  }
}

/** A source id is percent-encoded so untrusted ids cannot inject prompt headers. */
const sourceHeader = (chunk: Pick<RetrievedChunk, 'sourceId' | 'chunkIndex'>): string =>
  `[source:${encodeURIComponent(chunk.sourceId)}#${chunk.chunkIndex}]\n`;

/** Join ranked chunks under attributable `[source:<id>#<n>]` headers. */
const assembleContext = (chunks: ReadonlyArray<RetrievedChunk>): string =>
  chunks.map((chunk) => `${sourceHeader(chunk)}${chunk.text}`).join('\n\n');

export const defineRag = (config: RagConfig): Rag => {
  const name = config.name ?? 'default';
  const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const defaultTopK = config.topK ?? DEFAULT_TOP_K;
  const modelTag = config.embeddingModelVersion;
  const { vectors, publications, embed } = config;
  if (!Number.isInteger(vectors.maxTopK) || vectors.maxTopK < 1 || vectors.maxTopK > MAX_TOP_K)
    throw new Error('@velajs/ai/rag: vector maxTopK must be 1..100');
  if (!publications) throw new Error('@velajs/ai/rag: publications store is required');

  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error('@velajs/ai/rag: `chunkSize` must be a positive integer');
  }

  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error(
      '@velajs/ai/rag: `chunkOverlap` must be a non-negative integer smaller than `chunkSize`',
    );
  }

  if (
    !Number.isInteger(defaultTopK) ||
    defaultTopK < 1 ||
    defaultTopK > Math.min(MAX_TOP_K, vectors.maxTopK)
  ) {
    throw new Error(`@velajs/ai/rag: \`topK\` must be an integer between 1 and ${MAX_TOP_K}`);
  }

  if (
    modelTag !== undefined &&
    (typeof modelTag !== 'string' || !MODEL_VERSION_PATTERN.test(modelTag))
  ) {
    throw new Error(
      '@velajs/ai/rag: `embeddingModelVersion` must match /^[A-Za-z0-9._-]{1,40}$/ (a short stable tag like "bge-v1.5")',
    );
  }

  const splitter =
    config.chunk ??
    ((text: string): ReadonlyArray<string> => fixedWindowChunks(text, chunkSize, chunkOverlap));

  const embedText = async (text: string): Promise<number[]> => {
    const vector = await embed(text);

    if (!Array.isArray(vector) || vector.length < 1 || vector.length > MAX_VECTOR_DIMENSIONS) {
      throw new Error(
        `@velajs/ai/rag: embedder must return an array of 1..${MAX_VECTOR_DIMENSIONS} dimensions`,
      );
    }
    const values: number[] = [];
    for (const entry of vector) {
      if (typeof entry !== 'number' || !Number.isFinite(entry)) {
        throw new Error('@velajs/ai/rag: embedder vectors must contain only finite numbers');
      }
      values.push(entry);
    }

    return values;
  };

  /** Resolve the actual partition from trusted server context; raw values are selectors only. */
  const resolveEffectiveNamespace = async (
    operation: 'sync' | 'retrieve' | 'remove' | 'inspect' | 'reconcile',
    scope: SyncOptions | RetrieveOptions | RemoveOptions | undefined,
  ): Promise<string | undefined> => {
    const selector = scope?.namespace;
    if (
      selector !== undefined &&
      (typeof selector !== 'string' ||
        !selector.isWellFormed() ||
        bytes(selector) > MAX_NAMESPACE_BYTES)
    ) {
      throw new Error(
        `@velajs/ai/rag: namespace selectors must be strings of at most ${MAX_NAMESPACE_BYTES} bytes`,
      );
    }

    let namespace: string | undefined;
    if (config.resolveNamespace !== undefined) {
      namespace = await config.resolveNamespace({ operation, selector, auth: scope?.auth });
    } else if (selector !== undefined) {
      throw new Error(
        `@velajs/ai/rag: index "${name}" treats namespace values as untrusted selectors; ` +
          'configure `resolveNamespace` to derive and authorize the storage namespace',
      );
    }

    if (namespace === undefined) {
      if (config.allowSharedNamespace === true && !config.requireNamespace) {
        return foldModelVersion(undefined, modelTag);
      }
      throw new Error(
        `@velajs/ai/rag: index "${name}" requires a non-empty namespace derived by ` +
          '`resolveNamespace`, or { allowSharedNamespace: true } for a single-tenant index',
      );
    }
    if (
      typeof namespace !== 'string' ||
      !namespace.isWellFormed() ||
      namespace.trim().length === 0 ||
      namespace !== namespace.trim() ||
      bytes(namespace) > MAX_NAMESPACE_BYTES
    ) {
      throw new Error(
        `@velajs/ai/rag: resolveNamespace must return a non-empty canonical string of at most ${MAX_NAMESPACE_BYTES} bytes`,
      );
    }

    return foldModelVersion(namespace, modelTag);
  };

  const sourceKey = async (id: string): Promise<string> => {
    if (
      typeof id !== 'string' ||
      !id.isWellFormed() ||
      !id.trim() ||
      bytes(id) > MAX_SOURCE_ID_BYTES
    ) {
      throw new Error(
        `@velajs/ai/rag: source ids must be non-empty strings of at most ${MAX_SOURCE_ID_BYTES} bytes`,
      );
    }
    return sourceDigest(id);
  };
  const idsFor = (key: string, revision: string, count: number): string[] =>
    Array.from({ length: count }, (_, i) => `${key}:${revision}:${i}`);
  const checkRevision = (
    head: RagPublication | undefined,
    expected: string | null | undefined,
  ): void => {
    if ((head?.revision ?? null) !== (expected ?? null))
      throw new Error('@velajs/ai/rag: revision conflict; inspect the source before replacing it');
  };
  const mergeReceipts = (receipts: RagIndexingResult[]): RagIndexingResult => ({
    status: receipts.some((item) => item.status === 'accepted') ? 'accepted' : 'visible',
    mutationIds: receipts.flatMap((item) => item.mutationIds),
  });
  const readHead = (key: string, namespace: string | undefined) =>
    publications.transaction({ namespace }, (tx) => getPublication(tx, `h:${key}`));
  const requireCurrent = (head: RagPublication | undefined, revision: string): RagPublication => {
    if (!head || head.revision !== revision || head.state === 'deleted')
      throw new Error('@velajs/ai/rag: revision superseded or deleted');
    return head;
  };

  // Journal and text are persisted before any index side effects. Reconciliation
  // may re-embed and repeat an ambiguous upsert, always with the same attempt IDs.
  const indexRevision = async (
    key: string,
    revision: string,
    namespace: string | undefined,
    signal?: AbortSignal,
  ): Promise<RagPublication> => {
    signal?.throwIfAborted();
    const head = requireCurrent(await readHead(key, namespace), revision);
    const receipts: RagIndexingResult[] = [];
    const ids = idsFor(key, revision, head.chunks);
    for (let offset = 0; offset < ids.length; offset += 32) {
      signal?.throwIfAborted();
      // oxlint-disable-next-line eslint/no-await-in-loop
      const chunks = await publications.transaction({ namespace }, async (tx) => {
        requireCurrent(await getPublication(tx, `h:${key}`), revision);
        return Promise.all(
          ids.slice(offset, offset + 32).map((id) => getChunk(tx, `c:${id}`, head.sourceId)),
        );
      });
      // oxlint-disable-next-line eslint/no-await-in-loop
      const records = await mapWithConcurrency(chunks, DEFAULT_SYNC_CONCURRENCY, async (chunk) => {
        signal?.throwIfAborted();
        if (!chunk) throw new Error('@velajs/ai/rag: publication chunk missing');
        return { id: chunk.id, vector: await embedText(chunk.text) };
      });
      signal?.throwIfAborted();
      // oxlint-disable-next-line eslint/no-await-in-loop
      requireCurrent(await readHead(key, namespace), revision);
      // A concurrent remove can win while this network call is in flight. Its
      // tombstone/current revision remains authoritative even if this arrives late.
      // oxlint-disable-next-line eslint/no-await-in-loop
      receipts.push(parseIndexing(await vectors.upsert(records, { namespace })));
    }
    signal?.throwIfAborted();
    return publications.transaction({ namespace }, async (tx) => {
      const current = requireCurrent(await getPublication(tx, `h:${key}`), revision);
      const published: RagPublication = {
        ...current,
        state: 'published',
        indexing: mergeReceipts(receipts),
      };
      await tx.put(`h:${key}`, published);
      return published;
    });
  };

  const replace = async (
    document: RagDocument,
    options: SyncOptions | undefined,
    namespace: string | undefined,
  ): Promise<SyncResult> => {
    const key = await sourceKey(document.id);
    if (typeof document.text !== 'string' || bytes(document.text) > MAX_DOCUMENT_BYTES)
      throw new Error(`@velajs/ai/rag: document exceeds the ${MAX_DOCUMENT_BYTES}-byte limit`);
    if (
      document.importance !== undefined &&
      (!Number.isFinite(document.importance) || document.importance < 0)
    )
      throw new Error('@velajs/ai/rag: `importance` must be a non-negative finite number');
    const metadata = requireCallerMetadata(document.metadata, document.id);
    const rawPieces: unknown = splitter(document.text);
    if (!Array.isArray(rawPieces) || rawPieces.length > MAX_CHUNKS_PER_DOCUMENT)
      throw new Error(
        `@velajs/ai/rag: custom chunkers must return at most ${MAX_CHUNKS_PER_DOCUMENT} string chunks`,
      );
    const pieces: string[] = [];
    let total = 0;
    for (const piece of rawPieces) {
      if (typeof piece !== 'string' || bytes(piece) > MAX_CHUNK_BYTES)
        throw new Error(
          `@velajs/ai/rag: every chunk must be a string of at most ${MAX_CHUNK_BYTES} bytes`,
        );
      total += bytes(piece);
      if (total > MAX_TOTAL_CHUNK_BYTES)
        throw new Error(
          `@velajs/ai/rag: chunk output exceeds the ${MAX_TOTAL_CHUNK_BYTES}-byte aggregate limit`,
        );
      pieces.push(piece);
    }
    if (!pieces.length && options?.allowEmpty === false)
      throw new Error('@velajs/ai/rag: source produced zero chunks');
    const hash = await documentFingerprint(document, modelTag, pieces);
    const revision = crypto.randomUUID();
    const ids = idsFor(key, revision, pieces.length);
    options?.signal?.throwIfAborted();
    const claimed = await publications.transaction({ namespace }, async (tx) => {
      const old = await getPublication(tx, `h:${key}`);
      checkRevision(old, document.expectedRevision);
      if (old?.state === 'published' && old.hash === hash) return { head: old, unchanged: true };
      if (old)
        await Promise.all(idsFor(key, old.revision, old.chunks).map((id) => tx.delete(`c:${id}`)));
      const head: RagPublication = {
        sourceId: document.id,
        revision,
        state: pieces.length ? 'pending' : 'deleted',
        chunks: pieces.length,
        hash,
        importance: document.importance ?? 1,
        ...(metadata === undefined ? {} : { metadata }),
      };
      await tx.put(`h:${key}`, head);
      await tx.put(`j:${key}:${revision}`, {
        revision,
        chunks: pieces.length,
      } satisfies PublicationJournal);
      await Promise.all(
        pieces.map((text, chunkIndex) =>
          tx.put(`c:${ids[chunkIndex]!}`, {
            id: ids[chunkIndex]!,
            sourceId: document.id,
            key,
            revision,
            chunkIndex,
            text,
          } satisfies PublicationChunk),
        ),
      );
      return { head, unchanged: false };
    });
    let published = claimed.head;
    if (!claimed.unchanged && pieces.length) {
      try {
        published = await indexRevision(key, revision, namespace, options?.signal);
      } catch (cause) {
        throw new RagIndexingError(document.id, revision, cause);
      }
    }
    const publishedIds = idsFor(key, published.revision, published.chunks);
    if (!claimed.unchanged)
      pieces.forEach((text, chunkIndex) =>
        options?.onChunk?.({
          sourceId: document.id,
          chunkIndex,
          id: publishedIds[chunkIndex]!,
          text,
          total: pieces.length,
        }),
      );
    return {
      id: document.id,
      revision: published.revision,
      publication: published.state === 'deleted' ? 'deleted' : 'published',
      chunks: published.chunks,
      ids: publishedIds,
      unchanged: claimed.unchanged,
      ...(published.indexing === undefined ? {} : { indexing: published.indexing }),
    };
  };

  const sync = async (
    docs: ReadonlyArray<RagDocument>,
    options?: SyncOptions,
  ): Promise<ReadonlyArray<SyncResult>> => {
    if (!Array.isArray(docs) || docs.length > MAX_DOCUMENTS_PER_SYNC)
      throw new Error(
        `@velajs/ai/rag: sync accepts at most ${MAX_DOCUMENTS_PER_SYNC} documents per call`,
      );
    const namespace = await resolveEffectiveNamespace('sync', options);
    const results: SyncResult[] = [];
    for (const input of docs) {
      if (!isPlainRecord(input))
        throw new Error('@velajs/ai/rag: every document must be a plain object');
      for (const field of ['id', 'text', 'metadata', 'importance', 'expectedRevision']) {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (descriptor && !('value' in descriptor))
          throw new Error('@velajs/ai/rag: document fields must be own data properties');
      }
      if (typeof input.id !== 'string' || typeof input.text !== 'string')
        throw new Error('@velajs/ai/rag: document id and text must be strings');
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== null &&
        !isRevision(input.expectedRevision)
      )
        throw new Error('@velajs/ai/rag: expectedRevision must be a revision or null');
      const metadata = requireCallerMetadata(input.metadata, input.id);
      if (input.importance !== undefined && typeof input.importance !== 'number')
        throw new Error('@velajs/ai/rag: importance must be a number');
      const document: RagDocument = {
        id: input.id,
        text: input.text,
        ...(metadata === undefined ? {} : { metadata }),
        ...(input.importance === undefined ? {} : { importance: input.importance }),
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
      };
      // oxlint-disable-next-line eslint/no-await-in-loop
      results.push(await replace(document, options, namespace));
    }
    return results;
  };

  const inspect = async (
    id: string,
    options?: InspectOptions,
  ): Promise<RagPublication | undefined> => {
    const namespace = await resolveEffectiveNamespace('inspect', options);
    return readHead(await sourceKey(id), namespace);
  };
  const remove = async (id: string, options?: RemoveOptions): Promise<RagPublication> => {
    const namespace = await resolveEffectiveNamespace('remove', options);
    const key = await sourceKey(id);
    const revision = crypto.randomUUID();
    return publications.transaction({ namespace }, async (tx) => {
      const old = await getPublication(tx, `h:${key}`);
      checkRevision(old, options?.expectedRevision);
      if (old)
        await Promise.all(
          idsFor(key, old.revision, old.chunks).map((chunk) => tx.delete(`c:${chunk}`)),
        );
      const head: RagPublication = {
        sourceId: id,
        revision,
        state: 'deleted',
        chunks: 0,
        hash: '',
        importance: 1,
      };
      await tx.put(`h:${key}`, head);
      return head;
    });
  };
  const reconcile = async (id: string, options: ReconcileOptions): Promise<ReconcileResult> => {
    const namespace = await resolveEffectiveNamespace('reconcile', options);
    const key = await sourceKey(id);
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('@velajs/ai/rag: reconciliation limit must be 1..100');
    let head = await readHead(key, namespace);
    checkRevision(head, options.revision);
    if (!head) throw new Error('@velajs/ai/rag: source missing');
    if (head.state === 'pending' || (head.state === 'published' && options.reindex === true))
      head = await indexRevision(key, options.revision, namespace, options.signal);
    const journals = await publications.transaction({ namespace }, async (tx) => {
      checkRevision(await getPublication(tx, `h:${key}`), options.revision);
      return tx.list<PublicationJournal>({
        prefix: `j:${key}:`,
        after: options.after,
        limit: limit + 1,
      });
    });
    const cleanup: RagIndexingResult[] = [];
    const page = [...journals].slice(0, limit);
    for (const [journalKey, rawJournal] of page) {
      const journal = parseJournal(rawJournal);
      if (journalKey !== `j:${key}:${journal.revision}`)
        throw new Error('@velajs/ai/rag: corrupt journal key');
      options.signal?.throwIfAborted();
      if (journal.revision === head.revision) continue;
      const ids = idsFor(key, journal.revision, journal.chunks);
      if (ids.length) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        cleanup.push(await vectors.deleteByIds(ids, { namespace }));
      }
    }
    return {
      publication: head,
      cleanup,
      ...(journals.size > limit ? { cursor: page.at(-1)![0] } : {}),
    };
  };

  /** Resolve a named filter, or pass a literal filter object through. */
  const resolveFilter = (
    filter: Record<string, unknown> | string | undefined,
  ): Record<string, unknown> | undefined => {
    if (typeof filter !== 'string') {
      const bounded = boundedMetadata(filter, MAX_METADATA_BYTES);
      if (!bounded.valid) {
        throw new Error('@velajs/ai/rag: retrieval filters must be bounded plain JSON objects');
      }
      return bounded.value;
    }

    const descriptor =
      config.filters !== undefined
        ? Object.getOwnPropertyDescriptor(config.filters, filter)
        : undefined;
    const named = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;

    if (!isPlainRecord(named)) {
      throw new Error(
        `@velajs/ai/rag: unknown named filter "${filter}" — must be a key declared in RagConfig.filters`,
      );
    }

    const namedFilter = Object.getOwnPropertyDescriptor(named, 'filter');
    const bounded = boundedMetadata(
      namedFilter !== undefined && 'value' in namedFilter ? namedFilter.value : undefined,
      MAX_METADATA_BYTES,
    );
    if (!bounded.valid || bounded.value === undefined) {
      throw new Error(`@velajs/ai/rag: named filter "${filter}" is not bounded plain JSON`);
    }
    return bounded.value;
  };

  /** Keep the assembled prompt/result under a deterministic byte budget. */
  const boundResultChunks = (chunks: ReadonlyArray<RetrievedChunk>): RetrievedChunk[] => {
    const accepted: RetrievedChunk[] = [];
    let total = 0;

    for (const chunk of chunks) {
      const header = sourceHeader(chunk);
      const addition = bytes(header) + bytes(chunk.text) + (accepted.length > 0 ? 2 : 0);
      if (total + addition > MAX_CONTEXT_BYTES) break;
      total += addition;
      accepted.push(chunk);
    }

    return accepted;
  };

  const retrieve = async (query: string, options?: RetrieveOptions): Promise<RetrieveResult> => {
    if (typeof query !== 'string' || bytes(query) > MAX_QUERY_BYTES) {
      throw new Error(`@velajs/ai/rag: query exceeds the ${MAX_QUERY_BYTES}-byte limit`);
    }

    const effectiveNamespace = await resolveEffectiveNamespace('retrieve', options);
    const callerFilter = resolveFilter(options?.filter);

    // Row-level security: derive a filter from the retrieval identity and merge
    // it OVER the caller's filter — RLS keys win — so a caller can never widen
    // access past what RLS allows.
    const rawRls = config.rlsFilter ? await config.rlsFilter(options?.auth) : undefined;
    const boundedRls = boundedMetadata(rawRls, MAX_METADATA_BYTES);
    if (!boundedRls.valid) {
      throw new Error('@velajs/ai/rag: rlsFilter must return a bounded plain JSON object');
    }
    const effectiveFilter = {
      ...callerFilter,
      ...boundedRls.value,
    };
    const topK = options?.topK ?? defaultTopK;
    if (!Number.isInteger(topK) || topK < 1 || topK > Math.min(MAX_TOP_K, vectors.maxTopK)) {
      throw new Error(`@velajs/ai/rag: \`topK\` must be an integer between 1 and ${MAX_TOP_K}`);
    }
    if (
      options?.minScore !== undefined &&
      (typeof options.minScore !== 'number' || !Number.isFinite(options.minScore))
    ) {
      throw new Error('@velajs/ai/rag: `minScore` must be a finite number');
    }
    const before = options?.chunkContext?.before ?? 0;
    const after = options?.chunkContext?.after ?? 0;
    if (!Number.isInteger(before) || before < 0 || !Number.isInteger(after) || after < 0) {
      throw new Error(
        '@velajs/ai/rag: `chunkContext.before`/`chunkContext.after` must be non-negative integers',
      );
    }
    if (before > MAX_CHUNK_CONTEXT || after > MAX_CHUNK_CONTEXT) {
      throw new Error(
        `@velajs/ai/rag: chunk context is capped at ${MAX_CHUNK_CONTEXT} chunks per side`,
      );
    }

    const rawMatches: unknown = await vectors.query({
      vector: await embedText(query),
      topK,
      namespace: effectiveNamespace,
    });
    const matches = boundedVectorMatches(rawMatches, topK);
    // The entire authoritative read is one serializable snapshot. Revocation
    // linearizes here; an already returned response cannot be recalled.
    let chunks = await publications.transaction({ namespace: effectiveNamespace }, async (tx) => {
      const candidates: { stored: PublicationChunk; head: RagPublication; score: number }[] = [];
      for (const match of matches) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        const stored = await getChunk(tx, `c:${match.id}`);
        if (!stored || stored.id !== match.id) continue;
        // oxlint-disable-next-line eslint/no-await-in-loop
        const head = await getPublication(tx, `h:${stored.key}`);
        if (
          !head ||
          head.state !== 'published' ||
          head.revision !== stored.revision ||
          head.sourceId !== stored.sourceId ||
          stored.chunkIndex >= head.chunks ||
          !metadataMatchesFilter(head.metadata, effectiveFilter)
        )
          continue;
        const score = match.score * head.importance;
        if (
          !Number.isFinite(score) ||
          (options?.minScore !== undefined && score < options.minScore)
        )
          continue;
        candidates.push({ stored, head, score });
      }
      candidates.sort((left, right) => right.score - left.score);
      const output: RetrievedChunk[] = [];
      let outputBytes = 0;
      for (const { stored, head, score } of candidates) {
        const headerBytes = bytes(sourceHeader(stored)) + (output.length ? 2 : 0);
        const remaining = MAX_CONTEXT_BYTES - outputBytes - headerBytes;
        if (bytes(stored.text) > remaining) break;
        const parts: string[] = [];
        let expandedBytes = 0;
        for (
          let index = Math.max(0, stored.chunkIndex - before);
          index <= Math.min(head.chunks - 1, stored.chunkIndex + after);
          index++
        ) {
          // oxlint-disable-next-line eslint/no-await-in-loop
          const neighbor = await getChunk(
            tx,
            `c:${stored.key}:${stored.revision}:${index}`,
            head.sourceId,
          );
          if (neighbor) {
            expandedBytes += bytes(neighbor.text) + (parts.length ? 1 : 0);
            if (expandedBytes > remaining) break;
            parts.push(neighbor.text);
          }
        }
        const text = expandedBytes <= remaining ? parts.join('\n') : stored.text;
        outputBytes += headerBytes + bytes(text);
        output.push({
          id: stored.id,
          sourceId: stored.sourceId,
          chunkIndex: stored.chunkIndex,
          text,
          score,
          importance: head.importance,
          ...(head.metadata === undefined ? {} : { metadata: head.metadata }),
        });
      }
      return output;
    });

    // Importance can reorder; re-rank on the adjusted score before thresholding.
    chunks.sort((left, right) => right.score - left.score);

    if (options?.minScore !== undefined) {
      const threshold = options.minScore;
      chunks = chunks.filter((chunk) => chunk.score >= threshold);
    }

    options?.onRetrieve?.({ query, matches: chunks.length });

    chunks = boundResultChunks(chunks);

    const sources: RagSource[] = [];
    const seen = new Set<string>();

    for (const chunk of chunks) {
      if (!seen.has(chunk.sourceId)) {
        seen.add(chunk.sourceId);
        const source: RagSource = { id: chunk.sourceId, weight: chunk.importance };

        if (chunk.metadata !== undefined) {
          source.metadata = chunk.metadata;
        }

        sources.push(source);
      }
    }

    return { context: assembleContext(chunks), chunks, sources };
  };

  const asTool = (options?: RagToolOptions): Tool<{ query: string }, RetrieveResult> =>
    tool({
      description:
        options?.description ??
        `Search the "${name}" knowledge base for passages relevant to a natural-language query.`,
      inputSchema: jsonSchema<{ query: string }>(
        {
          type: 'object',
          properties: {
            query: { type: 'string', maxLength: MAX_QUERY_BYTES, description: 'The search query.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        {
          validate: (input) => {
            try {
              return { success: true, value: parseToolInput(input) };
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error : new Error(String(error)),
              };
            }
          },
        },
      ),
      execute: async (input): Promise<RetrieveResult> => {
        const { query } = parseToolInput(input);
        const retrieveOptions: RetrieveOptions = {};

        if (options?.namespace !== undefined) {
          retrieveOptions.namespace = options.namespace;
        }

        if (options?.topK !== undefined) {
          retrieveOptions.topK = options.topK;
        }

        if (options?.auth !== undefined) {
          retrieveOptions.auth = options.auth;
        }

        return retrieve(query, retrieveOptions);
      },
    });

  return { sync, retrieve, remove, inspect, reconcile, asTool };
};

const documentFingerprint = async (
  document: Pick<RagDocument, 'text' | 'metadata' | 'importance'>,
  modelTag: string | undefined,
  pieces: ReadonlyArray<string>,
): Promise<string> => {
  const canonical = canonicalJson(
    {
      text: document.text,
      metadata: document.metadata ?? null,
      importance: document.importance ?? null,
      modelTag: modelTag ?? null,
      pieces,
    },
    // JSON escaping can expand control characters by up to six bytes each. The
    // raw document and metadata limits are enforced before this bounded hash.
    {
      maxBytes: 6 * (MAX_DOCUMENT_BYTES + MAX_METADATA_BYTES + MAX_TOTAL_CHUNK_BYTES) + 32768,
      maxDepth: MAX_JSON_DEPTH + 2,
      maxNodes: MAX_JSON_NODES + MAX_CHUNKS_PER_DOCUMENT + 16,
      maxKeys: MAX_CHUNKS_PER_DOCUMENT,
    },
  );
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

interface CanonicalJsonLimits {
  maxBytes: number;
  maxDepth?: number;
  maxNodes?: number;
  maxKeys?: number;
}

interface CanonicalJsonState {
  bytes: number;
  nodes: number;
  readonly seen: WeakSet<object>;
  readonly limits: Required<CanonicalJsonLimits>;
}

/**
 * Canonicalise bounded plain JSON without evaluating accessors. This is used at
 * both caller and adapter boundaries, so hostile objects cannot turn metadata
 * hashing into unbounded recursion/allocation or execute getter code.
 */
const canonicalJson = (value: unknown, limits: CanonicalJsonLimits): string => {
  const state: CanonicalJsonState = {
    bytes: 0,
    nodes: 0,
    seen: new WeakSet<object>(),
    limits: {
      maxBytes: limits.maxBytes,
      maxDepth: limits.maxDepth ?? MAX_JSON_DEPTH,
      maxNodes: limits.maxNodes ?? MAX_JSON_NODES,
      maxKeys: limits.maxKeys ?? MAX_JSON_KEYS,
    },
  };

  const consume = (encoded: string): string => {
    state.bytes += bytes(encoded);
    if (state.bytes > state.limits.maxBytes) {
      throw new Error('@velajs/ai/rag: metadata exceeds its byte limit');
    }
    return encoded;
  };

  const encode = (entry: unknown, depth: number): string => {
    state.nodes += 1;
    if (state.nodes > state.limits.maxNodes || depth > state.limits.maxDepth) {
      throw new Error('@velajs/ai/rag: metadata exceeds its structural limits');
    }

    if (entry === null) return consume('null');
    if (typeof entry === 'string' || typeof entry === 'boolean') {
      return consume(JSON.stringify(entry));
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) {
        throw new Error('@velajs/ai/rag: metadata numbers must be finite');
      }
      return consume(JSON.stringify(entry));
    }
    if (typeof entry !== 'object') {
      throw new Error('@velajs/ai/rag: metadata must be JSON-serialisable');
    }
    if (state.seen.has(entry)) {
      throw new Error('@velajs/ai/rag: metadata must not contain cycles');
    }

    state.seen.add(entry);
    try {
      if (Array.isArray(entry)) {
        if (entry.length > state.limits.maxKeys) {
          throw new Error('@velajs/ai/rag: metadata exceeds its structural limits');
        }
        const encoded: string[] = [];
        consume('[');
        for (let index = 0; index < entry.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
          if (descriptor === undefined || !('value' in descriptor)) {
            throw new Error('@velajs/ai/rag: metadata arrays must be dense data arrays');
          }
          if (index > 0) consume(',');
          encoded.push(encode(descriptor.value, depth + 1));
        }
        consume(']');
        return `[${encoded.join(',')}]`;
      }

      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('@velajs/ai/rag: metadata must contain only plain JSON objects');
      }
      const keys = Object.keys(entry).toSorted();
      if (keys.length > state.limits.maxKeys) {
        throw new Error('@velajs/ai/rag: metadata exceeds its structural limits');
      }
      const encoded: string[] = [];
      consume('{');
      for (const [index, key] of keys.entries()) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new Error('@velajs/ai/rag: metadata accessors are not allowed');
        }
        if (index > 0) consume(',');
        const encodedKey = consume(JSON.stringify(key));
        consume(':');
        encoded.push(`${encodedKey}:${encode(descriptor.value, depth + 1)}`);
      }
      consume('}');
      return `{${encoded.join(',')}}`;
    } finally {
      state.seen.delete(entry);
    }
  };

  return encode(value, 0);
};
