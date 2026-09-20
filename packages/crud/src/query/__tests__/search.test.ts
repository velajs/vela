import { describe, expect, it } from 'vitest';
import type { SearchQuery } from '../../adapter/query-types';
import {
  calculateScore,
  generateHighlights,
  runSearchFallback,
  termFrequency,
  tokenize,
  tokenizeQuery,
  type SearchFieldConfig,
} from '../search';

describe('tokenize', () => {
  it('tokenizes a simple string', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('removes punctuation', () => {
    expect(tokenize("Hello, World! How's it going?")).toEqual(['hello', 'world', 'how', 'going']);
  });

  it('filters stop words by default', () => {
    expect(tokenize('The quick brown fox')).toEqual(['quick', 'brown', 'fox']);
  });

  it('keeps stop words when disabled', () => {
    expect(tokenize('The quick brown fox', false)).toEqual(['the', 'quick', 'brown', 'fox']);
  });

  it('handles empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('filters single-character tokens', () => {
    expect(tokenize('a b c test')).toEqual(['test']);
  });
});

describe('tokenizeQuery', () => {
  it('tokenizes for any/all mode', () => {
    expect(tokenizeQuery('hello world', 'any')).toEqual(['hello', 'world']);
    expect(tokenizeQuery('hello world', 'all')).toEqual(['hello', 'world']);
  });

  it('keeps the phrase intact for phrase mode', () => {
    expect(tokenizeQuery('Hello World', 'phrase')).toEqual(['hello world']);
  });
});

describe('termFrequency', () => {
  it('is count / total tokens', () => {
    expect(termFrequency('x', ['x', 'y', 'x', 'z'])).toBe(0.5);
    expect(termFrequency('x', [])).toBe(0);
  });
});

describe('calculateScore', () => {
  const searchFields: Record<string, SearchFieldConfig> = {
    title: { weight: 2.0 },
    content: { weight: 1.0 },
  };

  it('scores a matching record', () => {
    const record = {
      title: 'Introduction to TypeScript',
      content: 'TypeScript is a typed superset of JavaScript',
    };
    const { score, matchedFields } = calculateScore(record, ['typescript'], searchFields, 'any');
    expect(score).toBeGreaterThan(0);
    expect(matchedFields).toEqual(expect.arrayContaining(['title', 'content']));
  });

  it('returns zero for a non-matching record', () => {
    const record = { title: 'Introduction to Python', content: 'Python is a dynamic language' };
    const { score, matchedFields } = calculateScore(record, ['typescript'], searchFields, 'any');
    expect(score).toBe(0);
    expect(matchedFields).toHaveLength(0);
  });

  it('weights fields appropriately', () => {
    const titleMatch = { title: 'TypeScript Guide', content: 'Some other content' };
    const contentMatch = { title: 'Some title', content: 'Learn TypeScript today' };
    const titleScore = calculateScore(titleMatch, ['typescript'], searchFields, 'any');
    const contentScore = calculateScore(contentMatch, ['typescript'], searchFields, 'any');
    expect(titleScore.score).toBeGreaterThan(contentScore.score);
  });

  it('requires all terms for all mode', () => {
    const record = { title: 'TypeScript Guide', content: 'Introduction to TypeScript' };
    const anyResult = calculateScore(record, ['typescript', 'python'], searchFields, 'any');
    const allResult = calculateScore(record, ['typescript', 'python'], searchFields, 'all');
    expect(anyResult.score).toBeGreaterThan(0);
    expect(allResult.score).toBe(0);
  });
});

describe('generateHighlights', () => {
  it('highlights a matching term', () => {
    const highlights = generateHighlights(
      'TypeScript is great for building applications',
      ['typescript'],
      'any',
    );
    expect(highlights).toHaveLength(1);
    const first = highlights[0]!;
    expect(first.text.slice(first.ranges[0]?.start, first.ranges[0]?.end)).toBe('TypeScript');
  });

  it('highlights a phrase', () => {
    const highlights = generateHighlights(
      'The quick brown fox jumps over the lazy dog',
      ['quick brown'],
      'phrase',
    );
    expect(highlights).toHaveLength(1);
    const first = highlights[0]!;
    expect(first.text.slice(first.ranges[0]?.start, first.ranges[0]?.end)).toBe('quick brown');
  });

  it('handles no matches', () => {
    expect(generateHighlights('Hello world', ['typescript'], 'any')).toHaveLength(0);
  });

  it('handles array values', () => {
    const highlights = generateHighlights(['tag1', 'typescript', 'tag3'], ['typescript'], 'any');
    expect(highlights).toHaveLength(1);
    const first = highlights[0]!;
    expect(first.text.slice(first.ranges[0]?.start, first.ranges[0]?.end)).toBe('typescript');
  });

  it('returns inert text plus ranges instead of executable highlight HTML', () => {
    const highlights = generateHighlights(
      '<img src=x onerror=alert(1)> TypeScript',
      ['typescript'],
      'any',
    );
    const first = highlights[0]!;
    expect(first.text).toContain('<img src=x onerror=alert(1)>');
    expect(first.text).not.toContain('<mark>');
    expect(first.text.slice(first.ranges[0]?.start, first.ranges[0]?.end)).toBe('TypeScript');
  });
});

describe('runSearchFallback', () => {
  const rows = [
    { id: '1', title: 'TypeScript Handbook', body: 'A guide to TypeScript', status: 'published' },
    { id: '2', title: 'Python Handbook', body: 'A guide to Python', status: 'published' },
    {
      id: '3',
      title: 'Advanced TypeScript',
      body: 'Deep dive into TypeScript generics',
      status: 'draft',
    },
  ];

  const baseQuery = (over: Partial<SearchQuery>): SearchQuery => ({
    term: 'typescript',
    mode: 'any',
    fields: [
      { field: 'title', weight: 2 },
      { field: 'body', weight: 1 },
    ],
    filters: [],
    options: {},
    ...over,
  });

  it('returns only matching rows, sorted by descending score', () => {
    const hits = runSearchFallback(rows, baseQuery({}));
    const ids = hits.map((h) => h.record.id);
    expect(ids).toEqual(expect.arrayContaining(['1', '3']));
    expect(ids).not.toContain('2');
    // scores are monotonically non-increasing
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  it('applies WHERE filters before scoring', () => {
    const hits = runSearchFallback(
      rows,
      baseQuery({ filters: [{ field: 'status', operator: 'eq', value: 'published' }] }),
    );
    expect(hits.map((h) => h.record.id)).toEqual(['1']);
  });

  it('all mode requires every token to match', () => {
    const anyHits = runSearchFallback(
      rows,
      baseQuery({ term: 'typescript generics', mode: 'any' }),
    );
    const allHits = runSearchFallback(
      rows,
      baseQuery({ term: 'typescript generics', mode: 'all' }),
    );
    expect(anyHits.length).toBeGreaterThan(allHits.length);
    // only row 3 contains both "typescript" and "generics"
    expect(allHits.map((h) => h.record.id)).toEqual(['3']);
  });

  it('phrase mode matches an exact substring', () => {
    const hits = runSearchFallback(
      rows,
      baseQuery({ term: 'guide to typescript', mode: 'phrase' }),
    );
    expect(hits.map((h) => h.record.id)).toEqual(['1']);
  });

  it('attaches highlights for matched fields', () => {
    const hits = runSearchFallback(rows, baseQuery({}));
    const row1 = hits.find((h) => h.record.id === '1');
    const highlight = row1?.highlights?.title?.[0];
    expect(highlight?.text.slice(highlight.ranges[0]?.start, highlight.ranges[0]?.end)).toBe(
      'TypeScript',
    );
  });
});
