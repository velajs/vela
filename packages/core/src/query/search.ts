/**
 * Search engine: tokenization, weighted-TF scoring, highlighting, and the
 * in-memory `runSearchFallback` used when an adapter lacks `nativeSearch`.
 *
 * Faithful port of hono-crud 0.13's `endpoints/search-utils.ts` +
 * `searchInMemory`, retargeted onto the native engine's `SearchQuery` /
 * `SearchHit` shapes. Modes: `any` (OR), `all` (AND — every token must match),
 * `phrase` (exact substring). Scores are normalized to `[0, 1]` and weighted by
 * per-field relevance weight.
 */

import {
  type FilterCondition,
  type SearchHit,
  type SearchMode,
  type SearchQuery,
} from '../adapter/query-types';
import { applyFilters } from './filters';

/** Per-field search config: relevance weight + optional value handling. */
export interface SearchFieldConfig {
  /** Relevance weight (default 1.0); higher = more important. */
  weight?: number;
  /** `'array'` fields are joined before matching; others are `String()`-ed. */
  type?: 'text' | 'keyword' | 'array';
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were',
  'will', 'with',
]);

/**
 * Tokenize text into normalized terms: lowercased, punctuation stripped, split
 * on whitespace. With `removeStopWords` (default), common stop words and
 * single-character tokens are dropped.
 */
export function tokenize(text: string, removeStopWords = true): string[] {
  if (!text || typeof text !== 'string') {
    return [];
  }
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (removeStopWords) {
    return tokens.filter((token) => !STOP_WORDS.has(token) && token.length > 1);
  }
  return tokens;
}

/**
 * Tokenize a search query based on mode. `phrase` keeps the whole query as one
 * normalized token; `any`/`all` tokenize normally (stop words removed).
 */
export function tokenizeQuery(query: string, mode: SearchMode): string[] {
  if (mode === 'phrase') {
    return [query.toLowerCase().trim()];
  }
  return tokenize(query);
}

/** Parse a search mode string; falls back to `'any'`. */
export function parseSearchMode(value: string | undefined): SearchMode {
  if (value === 'all' || value === 'phrase') {
    return value;
  }
  return 'any';
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Term frequency: (# tokens equal to / containing `term`) / total tokens. */
export function termFrequency(term: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const count = tokens.filter((t) => t === term || t.includes(term)).length;
  return count / tokens.length;
}

/**
 * Score a record against tokenized query terms using weighted TF, returning the
 * normalized score `[0, 1]` and the matched field names. `all` mode zeroes a
 * field unless every query token matched it; `phrase` mode checks substring
 * containment of the single phrase token.
 */
export function calculateScore<T extends Record<string, unknown>>(
  record: T,
  queryTokens: string[],
  searchFields: Record<string, SearchFieldConfig>,
  mode: SearchMode,
): { score: number; matchedFields: string[] } {
  if (queryTokens.length === 0) {
    return { score: 0, matchedFields: [] };
  }

  let totalScore = 0;
  let maxPossibleScore = 0;
  const matchedFields: string[] = [];

  for (const [field, config] of Object.entries(searchFields)) {
    const fieldValue = record[field];
    if (fieldValue === undefined || fieldValue === null) {
      continue;
    }

    const weight = config.weight ?? 1.0;
    maxPossibleScore += weight;

    const content =
      config.type === 'array' && Array.isArray(fieldValue)
        ? fieldValue.join(' ')
        : String(fieldValue);

    const fieldTokens = tokenize(content, false);
    const contentLower = content.toLowerCase();

    let fieldScore = 0;
    let matchCount = 0;

    if (mode === 'phrase') {
      const phrase = queryTokens[0];
      if (contentLower.includes(phrase)) {
        fieldScore = 1.0;
        matchCount = 1;
      }
    } else {
      for (const queryToken of queryTokens) {
        const tf = termFrequency(queryToken, fieldTokens);
        if (tf > 0) {
          matchCount++;
          fieldScore += tf;
        } else if (contentLower.includes(queryToken)) {
          matchCount++;
          fieldScore += 0.5 / queryTokens.length;
        }
      }
      fieldScore = fieldScore / queryTokens.length;
    }

    // `all` mode requires every query token to match this field.
    if (mode === 'all' && matchCount < queryTokens.length) {
      fieldScore = 0;
    }

    if (fieldScore > 0) {
      matchedFields.push(field);
      totalScore += fieldScore * weight;
    }
  }

  const normalizedScore = maxPossibleScore > 0 ? Math.min(1, totalScore / maxPossibleScore) : 0;
  return { score: normalizedScore, matchedFields };
}

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

/**
 * Generate highlighted snippets for matched terms in a field value, wrapping
 * matches in `<tag>...</tag>` (default `mark`). Up to 3 snippets per field.
 */
export function generateHighlights(
  value: unknown,
  queryTokens: string[],
  mode: SearchMode,
  tag = 'mark',
  snippetLength = 150,
): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  const content = Array.isArray(value) ? value.join(' ') : String(value);
  if (!content || queryTokens.length === 0) {
    return [];
  }

  const highlights: string[] = [];
  const contentLower = content.toLowerCase();

  if (mode === 'phrase') {
    const phrase = queryTokens[0];
    const index = contentLower.indexOf(phrase);
    if (index !== -1) {
      const snippet = createSnippet(content, index, phrase.length, snippetLength, tag);
      if (snippet) highlights.push(snippet);
    }
    return highlights;
  }

  const matchPositions: Array<{ start: number; length: number }> = [];
  for (const token of queryTokens) {
    let searchIndex = 0;
    while (searchIndex < contentLower.length) {
      const index = contentLower.indexOf(token, searchIndex);
      if (index === -1) break;
      matchPositions.push({ start: index, length: token.length });
      searchIndex = index + 1;
    }
  }

  matchPositions.sort((a, b) => a.start - b.start);

  const usedPositions = new Set<number>();
  for (const pos of matchPositions) {
    const nearbyUsed = Array.from(usedPositions).some(
      (used) => Math.abs(used - pos.start) < snippetLength,
    );
    if (nearbyUsed) continue;

    const snippet = createSnippet(content, pos.start, pos.length, snippetLength, tag);
    if (snippet) {
      highlights.push(snippet);
      usedPositions.add(pos.start);
    }
    if (highlights.length >= 3) break;
  }

  return highlights;
}

/** Create one highlighted snippet around a match, trimmed to word boundaries. */
function createSnippet(
  content: string,
  matchStart: number,
  matchLength: number,
  snippetLength: number,
  tag: string,
): string | null {
  const halfSnippet = Math.floor(snippetLength / 2);
  let snippetStart = Math.max(0, matchStart - halfSnippet);
  let snippetEnd = Math.min(content.length, matchStart + matchLength + halfSnippet);

  if (snippetStart > 0) {
    const spaceIndex = content.indexOf(' ', snippetStart);
    if (spaceIndex !== -1 && spaceIndex < matchStart) {
      snippetStart = spaceIndex + 1;
    }
  }
  if (snippetEnd < content.length) {
    const spaceIndex = content.lastIndexOf(' ', snippetEnd);
    if (spaceIndex !== -1 && spaceIndex > matchStart + matchLength) {
      snippetEnd = spaceIndex;
    }
  }

  let snippet = content.slice(snippetStart, snippetEnd);
  if (snippetStart > 0) snippet = '...' + snippet;
  if (snippetEnd < content.length) snippet = snippet + '...';

  return highlightTermsInText(snippet, [content.slice(matchStart, matchStart + matchLength)], tag);
}

/** Wrap matched terms (longest first) in highlight tags within text. */
function highlightTermsInText(text: string, terms: string[], tag: string): string {
  let result = text;
  const textLower = text.toLowerCase();
  const sortedTerms = [...terms].sort((a, b) => b.length - a.length);

  for (const term of sortedTerms) {
    const termLower = term.toLowerCase();
    let lastIndex = 0;
    let highlighted = '';
    let searchIndex = 0;

    while (searchIndex < textLower.length) {
      const index = textLower.indexOf(termLower, searchIndex);
      if (index === -1) break;
      highlighted += result.slice(lastIndex, index);
      highlighted += `<${tag}>${result.slice(index, index + term.length)}</${tag}>`;
      lastIndex = index + term.length;
      searchIndex = lastIndex;
    }

    if (highlighted) {
      highlighted += result.slice(lastIndex);
      result = highlighted;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Engine-side fallback
// ---------------------------------------------------------------------------

/**
 * In-memory search fallback for adapters without `nativeSearch`. Applies the
 * query's WHERE `filters` first, then scores each surviving row over the
 * configured `fields` (with weights) in the requested `mode`, drops non-matches,
 * attaches highlights for matched fields, and returns hits sorted by descending
 * score.
 */
export function runSearchFallback<T extends Record<string, unknown>>(
  rows: T[],
  query: SearchQuery,
): Array<SearchHit<T>> {
  const queryTokens = tokenizeQuery(query.term, query.mode);

  const fieldsToSearch: Record<string, SearchFieldConfig> = {};
  for (const { field, weight } of query.fields) {
    fieldsToSearch[field] = { weight };
  }

  const candidates = applyFilters(rows, query.filters as FilterCondition[]);
  const hits: Array<SearchHit<T>> = [];

  for (const record of candidates) {
    const { score, matchedFields } = calculateScore(record, queryTokens, fieldsToSearch, query.mode);
    if (score <= 0 || matchedFields.length === 0) {
      continue;
    }

    const highlights: Record<string, string[]> = {};
    for (const field of matchedFields) {
      const fieldHighlights = generateHighlights(record[field], queryTokens, query.mode);
      if (fieldHighlights.length > 0) {
        highlights[field] = fieldHighlights;
      }
    }

    hits.push({
      record,
      score,
      highlights: Object.keys(highlights).length > 0 ? highlights : undefined,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}
