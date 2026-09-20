import type { Scorer, ScorerInput, ScoreResult } from './types.js';

/**
 * Force a raw number into the `[0, 1]` unit range. Anything non-finite (NaN,
 * Infinity) collapses to 0 so a broken scorer fails closed rather than skewing
 * an aggregate.
 */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }

  return value;
}

/** Coerce a scorer's return (a bare number or a full result) into a clamped {@link ScoreResult}. */
export function normalizeVerdict(value: number | ScoreResult): ScoreResult {
  if (typeof value === 'number') {
    return { score: clampUnit(value) };
  }
  if (value.reason === undefined) {
    return { score: clampUnit(value.score) };
  }

  return { score: clampUnit(value.score), reason: value.reason };
}

/** Arithmetic mean of a list; an empty list averages to 0. */
export function arithmeticMean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  let total = 0;

  for (const value of values) {
    total += value;
  }

  return total / values.length;
}

/** Case-fold a string unless the caller opted into case-sensitive matching. */
function fold(value: string, caseSensitive: boolean | undefined): string {
  return caseSensitive ? value : value.toLowerCase();
}

/** Options for {@link exactMatch}. */
export interface ExactMatchOptions {
  /** Trim leading/trailing whitespace before comparing (default `true`). */
  trim?: boolean;
  /** Compare with case sensitivity (default `true`). */
  caseSensitive?: boolean;
}

/**
 * Score 1 when the output equals the case's `expected`, else 0. Whitespace is
 * trimmed by default; a case with no `expected` scores 0 (there is nothing to
 * match against, so it fails closed).
 */
export function exactMatch(options: ExactMatchOptions = {}): Scorer {
  const trim = options.trim ?? true;
  const caseSensitive = options.caseSensitive ?? true;
  const shape = (value: string): string => {
    const trimmed = trim ? value.trim() : value;

    return caseSensitive ? trimmed : trimmed.toLowerCase();
  };

  return ({ output, expected }): number | ScoreResult => {
    if (expected === undefined) {
      return { score: 0, reason: 'no expected value to compare against' };
    }

    return shape(output) === shape(expected) ? 1 : 0;
  };
}

/** Options for {@link contains}. */
export interface ContainsOptions {
  /** `all` (default) requires every needle; `any` requires at least one. */
  mode?: 'all' | 'any';
  /** Match with case sensitivity (default: case-insensitive). */
  caseSensitive?: boolean;
}

/**
 * Binary substring scorer. Pass a single needle or a list; with a list, `mode`
 * chooses whether every needle must be present (`all`, the default) or just one
 * (`any`). Scores 1 when the condition holds, else 0.
 */
export function contains(
  needles: string | readonly string[],
  options: ContainsOptions = {},
): Scorer {
  const list = typeof needles === 'string' ? [needles] : [...needles];

  if (list.length === 0) {
    throw new Error('@velajs/testing: contains() needs at least one needle');
  }

  const mode = options.mode ?? 'all';
  const targets = list.map((needle) => fold(needle, options.caseSensitive));

  return ({ output }): number => {
    const haystack = fold(output, options.caseSensitive);
    const found = targets.map((target) => haystack.includes(target));
    const passed = mode === 'any' ? found.some(Boolean) : found.every(Boolean);

    return passed ? 1 : 0;
  };
}

/** Options for {@link keyword}. */
export interface KeywordOptions {
  /** Match with case sensitivity (default: case-insensitive). */
  caseSensitive?: boolean;
}

/**
 * Fractional coverage scorer: the share of `keywords` present in the output. A
 * rubric with three keywords, two of which appear, scores `2/3`. An empty
 * keyword list would silently score everything 1 — the opposite of a useful
 * eval — so it is rejected at construction time.
 */
export function keyword(keywords: readonly string[], options: KeywordOptions = {}): Scorer {
  if (keywords.length === 0) {
    throw new Error('@velajs/testing: keyword() needs at least one keyword');
  }

  const targets = keywords.map((word) => fold(word, options.caseSensitive));

  return ({ output }): ScoreResult => {
    const haystack = fold(output, options.caseSensitive);
    const hits = targets.filter((target) => haystack.includes(target)).length;

    return {
      score: hits / targets.length,
      reason: `${hits}/${targets.length} keywords present`,
    };
  };
}

/**
 * Score 1 when `pattern` matches the output, else 0. The global/sticky flags are
 * stripped from a copy of the pattern so a scorer reused across many samples
 * never carries `lastIndex` state between calls.
 */
export function regex(pattern: RegExp): Scorer {
  const stateless = new RegExp(pattern.source, pattern.flags.replace(/[gy]/gu, ''));

  return ({ output }): number => (stateless.test(output) ? 1 : 0);
}

/** Options for {@link llmScorer}. */
export interface LlmScorerOptions {
  /** The rubric the judge grades against, e.g. "answers the question accurately". */
  criteria: string;
  /**
   * The injected judge. Wire it to your own model call (`generateText`, a raw
   * fetch, whatever). Keeping it a plain callback is what lets this package
   * grade LLM output without depending on any AI SDK, and makes it trivial to
   * fake in tests.
   */
  judge: (prompt: string) => Promise<string>;
}

/** The regex that reads the leading number the judge is instructed to emit. */
const LEADING_NUMBER = /^\s*([+-]?\d+(?:\.\d+)?)/u;

/** Render the grading prompt for one sample under a rubric. */
export function renderJudgePrompt(criteria: string, sample: ScorerInput): string {
  const lines = [
    'You are grading an assistant output.',
    `Criterion: ${criteria}`,
    'Begin your reply with a single decimal from 0 (does not meet) to 1 (fully meets), then optionally a short justification.',
  ];

  if (sample.input !== undefined) {
    lines.push('', `Prompt: ${sample.input}`);
  }
  if (sample.expected !== undefined) {
    lines.push('', `Expected answer: ${sample.expected}`);
  }

  lines.push('', `Output to grade: ${sample.output}`);

  return lines.join('\n');
}

/**
 * Read a judge reply into a verdict. The score is the leading number, clamped,
 * and the full reply is kept as the reason. Requiring the number at the very
 * start is deliberate: a reply with no leading number fails closed to 0, and a
 * digit buried later in the justification can never be misread as the grade.
 */
export function parseJudgeReply(reply: string): ScoreResult {
  const match = LEADING_NUMBER.exec(reply);
  const reason = reply.trim();

  if (match === null) {
    return { score: 0, reason };
  }

  return { score: clampUnit(Number(match[1])), reason };
}

/**
 * LLM-as-judge scorer. It builds a rubric prompt, hands it to the injected
 * `judge`, and parses the reply into a `[0, 1]` grade. Unparseable replies fail
 * soft (score 0 with the raw reply as the reason) rather than throwing.
 */
export function llmScorer(options: LlmScorerOptions): Scorer {
  return async (sample): Promise<ScoreResult> =>
    parseJudgeReply(await options.judge(renderJudgePrompt(options.criteria, sample)));
}
