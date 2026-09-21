import { jsonSchema, tool } from 'ai';
import type { Tool } from 'ai';

import { fixedWindowChunks } from './chunk';
import { DEFAULT_SYNC_CONCURRENCY, mapWithConcurrency } from './concurrent';
import type {
  RemoveOptions,
  Rag,
  RagConfig,
  RagDocument,
  RagStoredChunk,
  RagStoredVector,
  RagVectorMatch,
  RagVectorRecord,
  RetrievedChunk,
  RetrieveOptions,
  RetrieveResult,
  RagSource,
  RagToolOptions,
  SyncOptions,
  SyncResult,
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
const MAX_STORED_METADATA_BYTES = 192 * 1024;
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

// Reserved metadata keys the helper writes onto each chunk vector. Namespaced so
// they never collide with caller metadata, and stripped back out before caller
// metadata is returned.
const META_SOURCE = '@velajs/ai:rag/source';
const META_INDEX = '@velajs/ai:rag/index';
const META_TEXT = '@velajs/ai:rag/text';
const META_HASH = '@velajs/ai:rag/hash';
const META_COUNT = '@velajs/ai:rag/count';
const META_IMPORTANCE = '@velajs/ai:rag/importance';
const META_MODEL = '@velajs/ai:rag/model';
const META_MANIFEST = '@velajs/ai:rag/manifest';

const RESERVED_KEYS = new Set([
  META_SOURCE,
  META_INDEX,
  META_TEXT,
  META_HASH,
  META_COUNT,
  META_IMPORTANCE,
  META_MODEL,
  META_MANIFEST,
]);

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

const boundedStoredVectors = (
  value: unknown,
  requestedIds: ReadonlyArray<string>,
): RagStoredVector[] => {
  let candidates: ReadonlyArray<unknown>;
  try {
    if (!Array.isArray(value)) return [];
    candidates = value;
  } catch {
    return [];
  }
  let inspected: ReadonlyArray<unknown>;
  try {
    inspected = candidates.slice(0, requestedIds.length);
  } catch {
    return [];
  }
  const requested = new Set(requestedIds);
  const accepted: RagStoredVector[] = [];

  for (const candidate of inspected) {
    if (!isPlainRecord(candidate)) continue;
    const idDescriptor = Object.getOwnPropertyDescriptor(candidate, 'id');
    const metadataDescriptor = Object.getOwnPropertyDescriptor(candidate, 'metadata');
    if (idDescriptor === undefined || !('value' in idDescriptor)) continue;
    const id = idDescriptor.value;
    if (typeof id !== 'string' || !requested.has(id)) continue;
    if (metadataDescriptor !== undefined && !('value' in metadataDescriptor)) continue;
    const metadata = boundedMetadata(metadataDescriptor?.value, MAX_STORED_METADATA_BYTES);
    if (!metadata.valid) continue;

    const record: RagStoredVector = { id };
    if (metadata.value !== undefined) record.metadata = metadata.value;
    accepted.push(record);
  }

  return accepted;
};

const metadataMatchesFilter = (
  metadata: Record<string, unknown> | undefined,
  filter: Record<string, unknown>,
): boolean => {
  if (metadata === undefined) return false;
  for (const [key, expected] of Object.entries(filter)) {
    if (!Object.hasOwn(metadata, key) || !Object.is(metadata[key], expected)) return false;
  }
  return true;
};

/** Bound and validate the runtime output of an untrusted vector adapter. */
const boundedVectorMatches = (
  value: unknown,
  topK: number,
  filter: Record<string, unknown>,
): RagVectorMatch[] => {
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
    const metadataDescriptor = Object.getOwnPropertyDescriptor(candidate, 'metadata');
    if (
      idDescriptor === undefined ||
      !('value' in idDescriptor) ||
      scoreDescriptor === undefined ||
      !('value' in scoreDescriptor) ||
      (metadataDescriptor !== undefined && !('value' in metadataDescriptor))
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
      !Number.isFinite(score)
    ) {
      continue;
    }
    const metadata = boundedMetadata(metadataDescriptor?.value, MAX_STORED_METADATA_BYTES);
    if (!metadata.valid || !metadataMatchesFilter(metadata.value, filter)) continue;

    const match: RagVectorMatch = { id, score };
    if (metadata.value !== undefined) match.metadata = metadata.value;
    accepted.push(match);
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

/** The segment prepended to a chunk id to scope it to its namespace. */
const namespaceSegment = (namespace: string | undefined): string =>
  namespace === undefined ? '' : `${encodeURIComponent(namespace)}#`;

const sourceSegment = (sourceId: string): string => encodeURIComponent(sourceId);

/** Stable manifest id atomically pointing at the committed generation. */
const manifestId = (namespace: string | undefined, sourceId: string): string =>
  `${namespaceSegment(namespace)}${sourceSegment(sourceId)}#manifest`;

/** Generation-specific chunk id; text and vector records always share it. */
const chunkId = (
  namespace: string | undefined,
  sourceId: string,
  generation: string,
  index: number,
): string => `${namespaceSegment(namespace)}${sourceSegment(sourceId)}#${generation}#${index}`;

/**
 * Invert {@link chunkId}. The (caller-known) namespace prefix is stripped first;
 * the chunk index is then the final `#`-delimited segment, so source ids may
 * themselves contain `#`.
 */
const parseChunkId = (
  id: string,
  namespace: string | undefined,
): { sourceId: string; generation: string; chunkIndex: number } | undefined => {
  const prefix = namespaceSegment(namespace);
  const body = prefix !== '' && id.startsWith(prefix) ? id.slice(prefix.length) : id;
  const indexCut = body.lastIndexOf('#');
  const generationCut = body.lastIndexOf('#', indexCut - 1);
  if (indexCut <= 0 || generationCut <= 0) return undefined;
  const index = Number(body.slice(indexCut + 1));
  const generation = body.slice(generationCut + 1, indexCut);
  if (!Number.isInteger(index) || index < 0 || !/^[a-f0-9]{64}$/.test(generation)) {
    return undefined;
  }
  try {
    return {
      sourceId: decodeURIComponent(body.slice(0, generationCut)),
      generation,
      chunkIndex: index,
    };
  } catch {
    return undefined;
  }
};

/** Encode both dimensions so tagged/untagged and shared/tenant spaces never alias. */
const foldModelVersion = (namespace: string | undefined, tag: string | undefined): string =>
  `@velajs/ai/rag:v1:${tag ?? ''}:${namespace === undefined ? 'shared' : `tenant:${namespace}`}`;

/** Strip reserved keys, returning caller metadata (or `undefined` if none remains). */
const callerMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (metadata === undefined) {
    return undefined;
  }

  const entries = Object.entries(metadata).filter(([key]) => !RESERVED_KEYS.has(key));

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

/** A source id is percent-encoded so untrusted ids cannot inject prompt headers. */
const sourceHeader = (chunk: Pick<RetrievedChunk, 'sourceId' | 'chunkIndex'>): string =>
  `[source:${encodeURIComponent(chunk.sourceId)}#${chunk.chunkIndex}]\n`;

/** Join ranked chunks under attributable `[source:<id>#<n>]` headers. */
const assembleContext = (chunks: ReadonlyArray<RetrievedChunk>): string =>
  chunks.map((chunk) => `${sourceHeader(chunk)}${chunk.text}`).join('\n\n');

/**
 * Declare a RAG index over a bring-your-own vector store and embedder. Returns
 * `{ sync, retrieve, remove, asTool }` — no per-request binding, no I/O until a
 * method runs.
 *
 * ```ts
 * import { defineRag, memoryVectors } from '@velajs/ai/rag';
 *
 * const docs = defineRag({
 *   name: 'docs',
 *   vectors: myVectorStore,
 *   embed: (text) => embedText(text),
 *   resolveNamespace: ({ selector, auth }) => authorizeTenant(auth, selector).tenantId,
 * });
 *
 * await docs.sync([{ id: 'guide', text: manual }], { namespace: tenantId, auth: identity });
 * const result = await docs.retrieve(question, { namespace: tenantId, auth: identity });
 * ```
 */
export const defineRag = (config: RagConfig): Rag => {
  const name = config.name ?? 'default';
  const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const defaultTopK = config.topK ?? DEFAULT_TOP_K;
  const modelTag = config.embeddingModelVersion;
  const { vectors, textStore, embed } = config;

  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error('@velajs/ai/rag: `chunkSize` must be a positive integer');
  }

  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error(
      '@velajs/ai/rag: `chunkOverlap` must be a non-negative integer smaller than `chunkSize`',
    );
  }

  if (!Number.isInteger(defaultTopK) || defaultTopK < 1 || defaultTopK > MAX_TOP_K) {
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
    operation: 'sync' | 'retrieve' | 'remove',
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

  /** Read the atomic manifest for a source's committed generation. */
  const readHead = async (
    sourceId: string,
    effectiveNamespace: string | undefined,
  ): Promise<{ hash?: string; chunks?: number }> => {
    const id = manifestId(effectiveNamespace, sourceId);
    const rawHeads = await vectors.getByIds([id], {
      namespace: effectiveNamespace,
    });
    const head = boundedStoredVectors(rawHeads, [id]).find((record) => record.id === id);

    const hash = head?.metadata?.[META_HASH];
    const chunks = head?.metadata?.[META_COUNT];
    const manifest = head?.metadata?.[META_MANIFEST];
    const result: { hash?: string; chunks?: number } = {};

    if (manifest !== true) return result;

    if (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) {
      result.hash = hash;
    }

    if (
      typeof chunks === 'number' &&
      Number.isInteger(chunks) &&
      chunks > 0 &&
      chunks <= MAX_CHUNKS_PER_DOCUMENT
    ) {
      result.chunks = chunks;
    }

    return result;
  };

  const deleteChunkRange = async (
    sourceId: string,
    generation: string,
    from: number,
    to: number,
    effectiveNamespace: string | undefined,
  ): Promise<void> => {
    const ids = Array.from({ length: Math.max(0, to - from) }, (_, offset) =>
      chunkId(effectiveNamespace, sourceId, generation, from + offset),
    );

    if (ids.length === 0) {
      return;
    }

    await vectors.deleteByIds(ids, { namespace: effectiveNamespace });
    await textStore?.remove(ids, { namespace: effectiveNamespace });
  };

  const syncDocument = async (
    document: RagDocument,
    options: SyncOptions | undefined,
    effectiveNamespace: string | undefined,
  ): Promise<SyncResult> => {
    if (
      typeof document.id !== 'string' ||
      !document.id.isWellFormed() ||
      document.id.trim().length === 0 ||
      bytes(document.id) > MAX_SOURCE_ID_BYTES
    ) {
      throw new Error(
        `@velajs/ai/rag: source ids must be non-empty strings of at most ${MAX_SOURCE_ID_BYTES} bytes`,
      );
    }
    if (typeof document.text !== 'string' || bytes(document.text) > MAX_DOCUMENT_BYTES) {
      throw new Error(
        `@velajs/ai/rag: document "${document.id}" exceeds the ${MAX_DOCUMENT_BYTES}-byte limit`,
      );
    }
    if (
      document.importance !== undefined &&
      (typeof document.importance !== 'number' ||
        !Number.isFinite(document.importance) ||
        document.importance < 0)
    ) {
      throw new Error('@velajs/ai/rag: `importance` must be a non-negative finite number');
    }
    const sourceMetadata = requireCallerMetadata(document.metadata, document.id);

    const rawPieces: unknown = splitter(document.text);
    if (!Array.isArray(rawPieces) || rawPieces.length > MAX_CHUNKS_PER_DOCUMENT) {
      throw new Error(
        `@velajs/ai/rag: custom chunkers must return at most ${MAX_CHUNKS_PER_DOCUMENT} string chunks`,
      );
    }
    const candidates: ReadonlyArray<unknown> = rawPieces;
    const pieces: string[] = [];
    let totalChunkBytes = 0;
    for (const piece of candidates) {
      if (typeof piece !== 'string' || bytes(piece) > MAX_CHUNK_BYTES) {
        throw new Error(
          `@velajs/ai/rag: every chunk must be a string of at most ${MAX_CHUNK_BYTES} bytes`,
        );
      }
      totalChunkBytes += bytes(piece);
      if (totalChunkBytes > MAX_TOTAL_CHUNK_BYTES) {
        throw new Error(
          `@velajs/ai/rag: chunk output exceeds the ${MAX_TOTAL_CHUNK_BYTES}-byte aggregate limit`,
        );
      }
      pieces.push(piece);
    }
    const fingerprintDocument: Pick<RagDocument, 'text' | 'metadata' | 'importance'> = {
      text: document.text,
    };
    if (sourceMetadata !== undefined) fingerprintDocument.metadata = sourceMetadata;
    if (document.importance !== undefined) fingerprintDocument.importance = document.importance;
    const hash = await documentFingerprint(
      fingerprintDocument,
      modelTag,
      pieces,
      textStore !== undefined,
    );
    const previous = await readHead(document.id, effectiveNamespace);

    // Unchanged content is a no-op re-sync: skip embedding and writes.
    if (previous.hash === hash && previous.chunks !== undefined) {
      return {
        id: document.id,
        chunks: previous.chunks,
        ids: Array.from({ length: previous.chunks }, (_, index) =>
          chunkId(effectiveNamespace, document.id, hash, index),
        ),
        unchanged: true,
      };
    }

    const ids = pieces.map((_, index) => chunkId(effectiveNamespace, document.id, hash, index));

    if (pieces.length === 0 && options?.allowEmpty === false) {
      throw new Error(
        `@velajs/ai/rag: source "${document.id}" produced zero chunks — set { allowEmpty: true } to allow this`,
      );
    }

    // Prepare every embedding before mutating either store. Chunk metadata
    // carries the generation hash so retrieval can reject partially staged
    // records whose hash does not match the committed head.
    const records = await mapWithConcurrency(
      pieces,
      DEFAULT_SYNC_CONCURRENCY,
      async (piece, chunkIndex): Promise<RagVectorRecord> => {
        const id = ids[chunkIndex] as string;
        const metadata: Record<string, unknown> = {
          ...sourceMetadata,
          [META_SOURCE]: document.id,
          [META_INDEX]: chunkIndex,
          [META_HASH]: hash,
          [META_MANIFEST]: false,
        };

        if (!textStore) {
          metadata[META_TEXT] = piece;
        }

        if (document.importance !== undefined) {
          metadata[META_IMPORTANCE] = document.importance;
        }

        return {
          id,
          vector: await embedText(piece),
          metadata,
        };
      },
    );

    const storedChunks: RagStoredChunk[] = pieces.map((text, chunkIndex) => ({
      id: ids[chunkIndex] as string,
      sourceId: document.id,
      chunkIndex,
      text,
    }));
    const previousIds =
      previous.hash === undefined
        ? []
        : Array.from({ length: previous.chunks ?? 0 }, (_, index) =>
            chunkId(effectiveNamespace, document.id, previous.hash!, index),
          );

    if (records.length === 0) {
      await vectors.deleteByIds([manifestId(effectiveNamespace, document.id), ...previousIds], {
        namespace: effectiveNamespace,
      });
      await textStore?.remove(previousIds, { namespace: effectiveNamespace });
      return { id: document.id, chunks: 0, ids: [], unchanged: false };
    }

    let publishing = false;
    try {
      if (storedChunks.length > 0 && textStore) {
        await textStore.put(storedChunks, { namespace: effectiveNamespace });
      }

      // All text/vector ids are generation-specific, so old authorized readers
      // can never hydrate newly staged text. The stable manifest flips only
      // after every new record is durable.
      await mapWithConcurrency(records, DEFAULT_SYNC_CONCURRENCY, async (record) => {
        await vectors.upsert([record], { namespace: effectiveNamespace });
      });

      const first = records[0]!;
      publishing = true;
      await vectors.upsert(
        [
          {
            id: manifestId(effectiveNamespace, document.id),
            vector: first.vector,
            metadata: {
              [META_SOURCE]: document.id,
              [META_HASH]: hash,
              [META_COUNT]: pieces.length,
              [META_MANIFEST]: true,
              ...(modelTag !== undefined ? { [META_MODEL]: modelTag } : {}),
            },
          },
        ],
        { namespace: effectiveNamespace },
      );
    } catch (error) {
      await textStore?.remove(ids, { namespace: effectiveNamespace });
      await vectors.deleteByIds(
        [...(publishing ? [manifestId(effectiveNamespace, document.id)] : []), ...ids],
        {
          namespace: effectiveNamespace,
        },
      );
      throw error;
    }

    for (const [chunkIndex, text] of pieces.entries()) {
      options?.onChunk?.({
        sourceId: document.id,
        chunkIndex,
        id: ids[chunkIndex] as string,
        text,
        total: pieces.length,
      });
    }

    // A shrinking re-sync leaves stale trailing chunks — delete them so they can
    // no longer match. New chunks are already written, so retrieval sees no gap.
    if (previous.hash !== undefined && previous.chunks !== undefined) {
      await deleteChunkRange(document.id, previous.hash, 0, previous.chunks, effectiveNamespace);
    }

    return { id: document.id, chunks: pieces.length, ids, unchanged: false };
  };

  const sync = async (
    docs: ReadonlyArray<RagDocument>,
    options?: SyncOptions,
  ): Promise<ReadonlyArray<SyncResult>> => {
    if (!Array.isArray(docs) || docs.length > MAX_DOCUMENTS_PER_SYNC) {
      throw new Error(
        `@velajs/ai/rag: sync accepts at most ${MAX_DOCUMENTS_PER_SYNC} documents per call`,
      );
    }

    const effectiveNamespace = await resolveEffectiveNamespace('sync', options);
    const results: SyncResult[] = [];

    const inputs: ReadonlyArray<unknown> = docs;
    for (const input of inputs) {
      if (!isPlainRecord(input)) {
        throw new Error('@velajs/ai/rag: every document must be a plain object');
      }
      const id = Object.getOwnPropertyDescriptor(input, 'id');
      const text = Object.getOwnPropertyDescriptor(input, 'text');
      const metadata = Object.getOwnPropertyDescriptor(input, 'metadata');
      const importance = Object.getOwnPropertyDescriptor(input, 'importance');
      if (
        id === undefined ||
        !('value' in id) ||
        text === undefined ||
        !('value' in text) ||
        (metadata !== undefined && !('value' in metadata)) ||
        (importance !== undefined && !('value' in importance))
      ) {
        throw new Error('@velajs/ai/rag: document fields must be own data properties');
      }
      const rawId: unknown = id.value;
      const rawText: unknown = text.value;
      if (typeof rawId !== 'string' || typeof rawText !== 'string') {
        throw new Error('@velajs/ai/rag: document id and text must be strings');
      }
      const document: RagDocument = { id: rawId, text: rawText };
      if (metadata !== undefined) {
        const rawMetadata: unknown = metadata.value;
        if (!isPlainRecord(rawMetadata)) {
          throw new Error('@velajs/ai/rag: document metadata must be a plain JSON object');
        }
        document.metadata = rawMetadata;
      }
      if (importance !== undefined) {
        const rawImportance: unknown = importance.value;
        if (typeof rawImportance !== 'number') {
          throw new Error('@velajs/ai/rag: document importance must be a number');
        }
        document.importance = rawImportance;
      }
      // Keep document publication ordered and bound concurrent embedding/storage work per source.
      // oxlint-disable-next-line eslint/no-await-in-loop
      results.push(await syncDocument(document, options, effectiveNamespace));
    }

    return results;
  };

  const remove = async (id: string, options?: RemoveOptions): Promise<void> => {
    if (
      typeof id !== 'string' ||
      !id.isWellFormed() ||
      id.trim().length === 0 ||
      bytes(id) > MAX_SOURCE_ID_BYTES
    ) {
      throw new Error(
        `@velajs/ai/rag: source ids must be non-empty strings of at most ${MAX_SOURCE_ID_BYTES} bytes`,
      );
    }

    const effectiveNamespace = await resolveEffectiveNamespace('remove', options);
    const previous = await readHead(id, effectiveNamespace);
    if (previous.hash !== undefined && previous.chunks !== undefined) {
      await deleteChunkRange(id, previous.hash, 0, previous.chunks, effectiveNamespace);
    }
    await vectors.deleteByIds([manifestId(effectiveNamespace, id)], {
      namespace: effectiveNamespace,
    });
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

  /** Fetch chunk texts by id — from the text store, or from vector metadata. */
  const textsByIds = async (
    ids: ReadonlyArray<string>,
    effectiveNamespace: string | undefined,
  ): Promise<Map<string, string>> => {
    const texts = new Map<string, string>();

    if (ids.length === 0) {
      return texts;
    }

    if (textStore) {
      const rawStored: unknown = await textStore.getMany(ids, { namespace: effectiveNamespace });
      if (!Array.isArray(rawStored)) return texts;
      const stored: ReadonlyArray<unknown> = rawStored;

      for (const [position, id] of ids.entries()) {
        const text = stored[position];

        if (typeof text === 'string' && bytes(text) <= MAX_CHUNK_BYTES) {
          texts.set(id, text);
        }
      }

      return texts;
    }

    const rawRecords = await vectors.getByIds(ids, { namespace: effectiveNamespace });
    const records = boundedStoredVectors(rawRecords, ids);

    for (const record of records) {
      const text = record.metadata?.[META_TEXT];

      if (typeof text === 'string' && bytes(text) <= MAX_CHUNK_BYTES) {
        texts.set(record.id, text);
      }
    }

    return texts;
  };

  /** Turn raw vector matches into ranked chunks, folding in per-source importance. */
  const parseMatches = (
    matches: ReadonlyArray<RagVectorMatch>,
    effectiveNamespace: string | undefined,
  ): RetrievedChunk[] =>
    matches.flatMap((match) => {
      const metadata = match.metadata ?? {};
      const parsed = parseChunkId(match.id, effectiveNamespace);
      if (parsed === undefined) return [];
      const rawImportance = metadata[META_IMPORTANCE];
      const importance =
        typeof rawImportance === 'number' && Number.isFinite(rawImportance) && rawImportance >= 0
          ? rawImportance
          : 1;
      const rawText = metadata[META_TEXT];
      if (
        rawText !== undefined &&
        (typeof rawText !== 'string' || bytes(rawText) > MAX_CHUNK_BYTES)
      ) {
        return [];
      }
      const score = match.score * importance;
      if (!Number.isFinite(score)) return [];
      const caller = callerMetadata(metadata);

      const chunk: RetrievedChunk = {
        id: match.id,
        sourceId: parsed.sourceId,
        chunkIndex: parsed.chunkIndex,
        text: typeof rawText === 'string' ? rawText : '',
        score,
        importance,
      };

      if (caller !== undefined) {
        chunk.metadata = caller;
      }

      return [chunk];
    });

  /** Drop staged/stale matches whose generation is not the committed head. */
  const committedMatches = async (
    matches: ReadonlyArray<RagVectorMatch>,
    effectiveNamespace: string | undefined,
  ): Promise<RagVectorMatch[]> => {
    const prefix = namespaceSegment(effectiveNamespace);
    const candidates = matches.flatMap((match) => {
      if (prefix !== '' && !match.id.startsWith(prefix)) return [];
      const parsed = parseChunkId(match.id, effectiveNamespace);
      if (parsed === undefined || match.metadata?.[META_MANIFEST] !== false) return [];
      const storedSource = match.metadata?.[META_SOURCE];
      const storedIndex = match.metadata?.[META_INDEX];
      const hash = match.metadata?.[META_HASH];
      if (
        storedSource !== parsed.sourceId ||
        storedIndex !== parsed.chunkIndex ||
        hash !== parsed.generation ||
        bytes(parsed.sourceId) > MAX_SOURCE_ID_BYTES
      ) {
        return [];
      }
      return [
        {
          match,
          sourceId: parsed.sourceId,
          hash: parsed.generation,
        },
      ];
    });
    const headIds = [
      ...new Set(candidates.map(({ sourceId }) => manifestId(effectiveNamespace, sourceId))),
    ];
    const rawHeads = await vectors.getByIds(headIds, { namespace: effectiveNamespace });
    const heads = boundedStoredVectors(rawHeads, headIds);
    const committed = new Map<string, string>();
    for (const head of heads) {
      const hash = head.metadata?.[META_HASH];
      if (
        head.metadata?.[META_MANIFEST] === true &&
        typeof hash === 'string' &&
        /^[a-f0-9]{64}$/.test(hash)
      ) {
        committed.set(head.id, hash);
      }
    }
    return candidates.flatMap(({ match, sourceId, hash }) =>
      committed.get(manifestId(effectiveNamespace, sourceId)) === hash ? [match] : [],
    );
  };

  /** In text-store mode, hydrate each chunk's text; drop chunks whose text is gone. */
  const hydrateFromStore = async (
    chunks: RetrievedChunk[],
    effectiveNamespace: string | undefined,
  ): Promise<RetrievedChunk[]> => {
    if (!textStore) {
      return chunks;
    }

    const texts = await textsByIds(
      chunks.map((chunk) => chunk.id),
      effectiveNamespace,
    );

    return chunks.flatMap((chunk) => {
      const text = texts.get(chunk.id);

      return text === undefined ? [] : [{ ...chunk, text }];
    });
  };

  /** Stitch each chunk's ± `chunkContext` neighbours into its text, in document order. */
  const expandChunks = async (
    chunks: ReadonlyArray<RetrievedChunk>,
    options: RetrieveOptions | undefined,
    effectiveNamespace: string | undefined,
  ): Promise<RetrievedChunk[]> => {
    const before = options?.chunkContext?.before ?? 0;
    const after = options?.chunkContext?.after ?? 0;

    if (before === 0 && after === 0) {
      return [...chunks];
    }

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

    const known = new Map(chunks.map((chunk) => [chunk.id, chunk.text]));
    const neighbourIds = new Set<string>();

    for (const chunk of chunks) {
      const generation = parseChunkId(chunk.id, effectiveNamespace)?.generation;
      if (generation === undefined) continue;
      for (let offset = -before; offset <= after; offset += 1) {
        const neighbourIndex = chunk.chunkIndex + offset;
        const id = chunkId(effectiveNamespace, chunk.sourceId, generation, neighbourIndex);

        if (offset !== 0 && neighbourIndex >= 0 && !known.has(id)) {
          neighbourIds.add(id);
        }
      }
    }

    const neighbourTexts = await textsByIds([...neighbourIds], effectiveNamespace);
    const textAt = (sourceId: string, generation: string, index: number): string | undefined => {
      const id = chunkId(effectiveNamespace, sourceId, generation, index);

      return known.get(id) ?? neighbourTexts.get(id);
    };

    return chunks.map((chunk) => {
      const parts: string[] = [];
      const generation = parseChunkId(chunk.id, effectiveNamespace)?.generation;

      for (let offset = -before; offset <= after; offset += 1) {
        const text =
          offset === 0
            ? chunk.text
            : generation === undefined
              ? undefined
              : textAt(chunk.sourceId, generation, chunk.chunkIndex + offset);

        if (text !== undefined) {
          parts.push(text);
        }
      }

      const text = parts.join('\n');

      // A wide context request over maximum-sized custom chunks must not turn a
      // bounded retrieval into a multi-megabyte amplification. Keep the ranked
      // chunk itself when neighbour expansion would exceed the result budget.
      return bytes(text) <= MAX_CONTEXT_BYTES ? { ...chunk, text } : { ...chunk };
    });
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
      [META_MANIFEST]: false,
    };
    const topK = options?.topK ?? defaultTopK;
    if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
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
      filter: effectiveFilter,
      returnMetadata: 'all',
    });
    const matches = boundedVectorMatches(rawMatches, topK, effectiveFilter);

    let chunks = await hydrateFromStore(
      parseMatches(await committedMatches(matches, effectiveNamespace), effectiveNamespace),
      effectiveNamespace,
    );

    // Importance can reorder; re-rank on the adjusted score before thresholding.
    chunks.sort((left, right) => right.score - left.score);

    if (options?.minScore !== undefined) {
      const threshold = options.minScore;
      chunks = chunks.filter((chunk) => chunk.score >= threshold);
    }

    options?.onRetrieve?.({ query, matches: chunks.length });

    chunks = boundResultChunks(await expandChunks(chunks, options, effectiveNamespace));

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

  return { sync, retrieve, remove, asTool };
};

const documentFingerprint = async (
  document: Pick<RagDocument, 'text' | 'metadata' | 'importance'>,
  modelTag: string | undefined,
  pieces: ReadonlyArray<string>,
  externalText: boolean,
): Promise<string> => {
  const canonical = canonicalJson(
    {
      text: document.text,
      metadata: document.metadata ?? null,
      importance: document.importance ?? null,
      modelTag: modelTag ?? null,
      pieces,
      externalText,
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
