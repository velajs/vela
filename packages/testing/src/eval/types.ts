/**
 * Shared types for the output-evaluation harness.
 *
 * The harness is model-agnostic: a {@link Scorer} is any function that turns one
 * sample into a `[0, 1]` score, and {@link evaluate} drives a dataset through a
 * producer and grades every output. Nothing here reaches for an AI SDK — the
 * only "AI" surface is `llmScorer`, whose judge callback is injected by the
 * caller.
 */

/** A value that may be produced synchronously or via a promise. */
export type Awaitable<T> = T | Promise<T>;

/** The single sample handed to a {@link Scorer}. */
export interface ScorerInput {
  /** The prompt/input that produced {@link ScorerInput.output}, for judge context. */
  input?: string;
  /** The output under test — the only field every scorer is guaranteed to see. */
  output: string;
  /** The reference answer, when a scorer grades against a gold value. */
  expected?: string;
  /** Free-form per-sample metadata carried through untouched. */
  metadata?: Record<string, unknown>;
}

/** A scorer's verdict: a `[0, 1]` score plus an optional human-readable reason. */
export interface ScoreResult {
  /** The grade, always clamped into `[0, 1]` by the harness. */
  score: number;
  /** Why the scorer landed on this grade. */
  reason?: string;
}

/**
 * A scorer maps one sample to a grade. Returning a bare number is shorthand for
 * `{ score }`; return a {@link ScoreResult} to attach a reason. Sync or async.
 */
export type Scorer = (input: ScorerInput) => Awaitable<number | ScoreResult>;

/** One dataset row: an input plus an optional gold answer and metadata. */
export interface EvalCase {
  input: string;
  expected?: string;
  metadata?: Record<string, unknown>;
}

/** The result of grading one case: the produced output and each scorer's verdict. */
export interface CaseReport {
  input: string;
  output: string;
  /** Each scorer's verdict, keyed by the name it was registered under. */
  scores: Record<string, ScoreResult>;
  /** The mean of this case's scores across all scorers. */
  average: number;
}

/** The roll-up across every case. */
export interface EvalAggregate {
  /** Mean score of each scorer across all cases, keyed by scorer name. */
  perScorer: Record<string, number>;
  /** Mean of every case's average — the single headline number. */
  overall: number;
}

/** The full run: one report per case plus the aggregate roll-up. */
export interface EvalReport {
  cases: CaseReport[];
  aggregate: EvalAggregate;
}
