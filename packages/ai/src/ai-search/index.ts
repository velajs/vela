import { jsonSchema, tool } from 'ai';
import type { Tool } from 'ai';

/** The subset of the native namespace search request emitted by this helper. */
export interface AiSearchRequest {
  messages: Array<{ role: 'user'; content: string }>;
  ai_search_options: {
    instance_ids: string[];
    retrieval: { max_num_results: number; context_expansion: 0; return_on_failure: false };
    cache: { enabled: false };
  };
}

/** Accepts an AI Search namespace binding; response data is validated before use. */
export interface AiSearchBinding {
  search(request: AiSearchRequest): Promise<unknown>;
}

/** An immutable item key within the configured namespace and instance. */
export interface AiSearchSource {
  readonly instanceId: string;
  readonly key: string;
}

export interface AiSearchCitation extends AiSearchSource {
  /** Result-local citation label, used by the context's [source:N] headers. */
  readonly id: string;
  readonly chunkId: string;
}

export interface AiSearchChunk {
  readonly text: string;
  readonly score: number;
  readonly citation: AiSearchCitation;
}

export interface AiSearchResult {
  readonly context: string;
  readonly chunks: ReadonlyArray<AiSearchChunk>;
  readonly citations: ReadonlyArray<AiSearchCitation>;
}

export interface AiSearchConfig {
  /** Environment-owned namespace binding; never selected by model input. */
  binding: AiSearchBinding;
  /** Server-authorized instances for this request, 1..10. Copied at construction. */
  instanceIds: ReadonlyArray<string>;
  /**
   * Check current identity, ACL, deletion and publication state in authoritative
   * storage. Only literal true permits a source. Called again on every retrieval;
   * no indexed metadata is supplied as authority. Use immutable item keys for
   * revisions, and deny keys that are no longer published. Do not cache this
   * decision across requests or derive it from search results.
   */
  authorizeSource(source: AiSearchSource): boolean | Promise<boolean>;
  /** Candidate depth before authorization; 1..50, default 10. */
  maxResults?: number;
}

export interface AiSearch {
  retrieve(query: string): Promise<AiSearchResult>;
  asTool(): Tool<{ query: string }, AiSearchResult>;
}

const encoder = new TextEncoder();
const MAX_QUERY_BYTES = 32 * 1024;
const MAX_CONTEXT_BYTES = 512 * 1024;
const fail = (message: string): never => {
  throw new Error(`@velajs/ai/ai-search: ${message}`);
};

const stringWithin = (value: unknown, limit: number): value is string =>
  typeof value === 'string' &&
  value.length <= limit &&
  value.isWellFormed() &&
  value.trim().length > 0 &&
  encoder.encode(value).byteLength <= limit;

/** Read data properties without invoking accessors or accepting inherited fields. */
const field = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== 'object') return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};

const parseQuery = (query: unknown): string =>
  stringWithin(query, MAX_QUERY_BYTES)
    ? query
    : fail(`query must be a non-empty string of at most ${MAX_QUERY_BYTES} UTF-8 bytes`);

const parseInput = (input: unknown): { query: string } => {
  const query = field(input, 'query');
  if (input === null || typeof input !== 'object' || Reflect.ownKeys(input).length !== 1) {
    return fail('tool input must contain only query');
  }
  return { query: parseQuery(query) };
};

interface Candidate extends AiSearchSource {
  chunkId: string;
  text: string;
  score: number;
}

const parseCandidate = (value: unknown, allowed: ReadonlySet<string>): Candidate | undefined => {
  const instanceId = field(value, 'instance_id');
  const chunkId = field(value, 'id');
  const text = field(value, 'text');
  const score = field(value, 'score');
  const key = field(field(value, 'item'), 'key');
  if (
    typeof instanceId !== 'string' ||
    !allowed.has(instanceId) ||
    field(value, 'type') !== 'text' ||
    !stringWithin(chunkId, 1024) ||
    !stringWithin(key, 4096) ||
    !stringWithin(text, 64 * 1024) ||
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 1
  )
    return undefined;
  return { instanceId, key, chunkId, text, score };
};

/**
 * Bind managed retrieval to one environment and verified request. Native item
 * ingestion/administration stays on the binding; this is not a RagVectors store.
 */
export const createAiSearch = (config: AiSearchConfig): AiSearch => {
  const { binding, authorizeSource, maxResults = 10 } = config;
  if (
    !Array.isArray(config.instanceIds) ||
    config.instanceIds.length < 1 ||
    config.instanceIds.length > 10
  ) {
    return fail('instanceIds must contain 1..10 server-authorized instances');
  }
  const instanceIds: string[] = [];
  for (const id of config.instanceIds) {
    if (!stringWithin(id, 256) || id.trim() !== id) return fail('invalid instance id');
    instanceIds.push(id);
  }
  const allowed = new Set(instanceIds);
  if (allowed.size !== instanceIds.length) return fail('instanceIds must be unique');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
    return fail('maxResults must be an integer between 1 and 50');
  }
  if (typeof authorizeSource !== 'function') return fail('authorizeSource is required');
  const search = binding.search.bind(binding);

  const retrieve = async (query: string): Promise<AiSearchResult> => {
    const response: unknown = await search({
      messages: [{ role: 'user', content: parseQuery(query) }],
      ai_search_options: {
        instance_ids: [...instanceIds],
        retrieval: { max_num_results: maxResults, context_expansion: 0, return_on_failure: false },
        cache: { enabled: false },
      },
    });
    const errors = field(response, 'errors');
    if (errors !== undefined && (!Array.isArray(errors) || errors.length !== 0)) {
      return fail('search failed for one or more instances');
    }
    const rawChunks = field(response, 'chunks');
    if (!Array.isArray(rawChunks)) return fail('invalid search response');

    const chunks: AiSearchChunk[] = [];
    const decisions = new Map<string, boolean>();
    const seen = new Set<string>();
    const context: string[] = [];
    let contextBytes = 0;
    // Bound inspection and policy calls even when the service returns excess data.
    for (let index = 0; index < Math.min(rawChunks.length, maxResults); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(rawChunks, String(index));
      const candidate = parseCandidate(
        descriptor && 'value' in descriptor ? descriptor.value : undefined,
        allowed,
      );
      if (!candidate) continue;
      const sourceKey = JSON.stringify([candidate.instanceId, candidate.key]);
      const chunkKey = JSON.stringify([candidate.instanceId, candidate.key, candidate.chunkId]);
      if (seen.has(chunkKey)) continue;
      seen.add(chunkKey);
      let authorized = decisions.get(sourceKey);
      if (authorized === undefined) {
        authorized =
          // Keep policy I/O bounded and stop starting reads after an authority failure.
          // oxlint-disable-next-line eslint/no-await-in-loop
          (await authorizeSource(
            Object.freeze({
              instanceId: candidate.instanceId,
              key: candidate.key,
            }),
          )) === true;
        decisions.set(sourceKey, authorized);
      }
      if (!authorized) continue;
      const citation: AiSearchCitation = {
        id: String(chunks.length + 1),
        instanceId: candidate.instanceId,
        key: candidate.key,
        chunkId: candidate.chunkId,
      };
      const part = `[source:${citation.id}]\n${candidate.text}`;
      const addition = encoder.encode(part).byteLength + (context.length > 0 ? 2 : 0);
      if (contextBytes + addition > MAX_CONTEXT_BYTES) continue;
      contextBytes += addition;
      chunks.push({ text: candidate.text, score: candidate.score, citation });
      context.push(part);
    }
    return {
      context: context.join('\n\n'),
      chunks,
      citations: chunks.map((chunk) => chunk.citation),
    };
  };

  const asTool = (): Tool<{ query: string }, AiSearchResult> =>
    tool({
      description: 'Search the authorized knowledge sources for relevant passages with citations.',
      inputSchema: jsonSchema<{ query: string }>(
        {
          type: 'object',
          properties: { query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_BYTES } },
          required: ['query'],
          additionalProperties: false,
        },
        {
          validate: (input) => {
            try {
              return { success: true, value: parseInput(input) };
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error : new Error('Invalid tool input'),
              };
            }
          },
        },
      ),
      execute: async (input) => retrieve(parseInput(input).query),
    });
  return { retrieve, asTool };
};
