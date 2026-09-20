import { arithmeticMean, normalizeVerdict } from './scorers.js';
import type {
  Awaitable,
  CaseReport,
  EvalCase,
  EvalReport,
  Scorer,
  ScorerInput,
  ScoreResult,
} from './types.js';

/** Run every scorer over one sample and collect the verdicts keyed by scorer name. */
async function gradeSample(
  sample: ScorerInput,
  scorers: Record<string, Scorer>,
): Promise<Record<string, ScoreResult>> {
  const graded = await Promise.all(
    Object.entries(scorers).map(async ([name, scorer]): Promise<[string, ScoreResult]> => {
      return [name, normalizeVerdict(await scorer(sample))];
    }),
  );

  const scores: Record<string, ScoreResult> = {};

  for (const [name, verdict] of graded) {
    scores[name] = verdict;
  }

  return scores;
}

/**
 * Run a whole dataset through `run` and grade each output with the named
 * `scorers`. Every case is graded by every scorer; cases execute concurrently,
 * so keep `run` stateless per input (or key any shared state on `input`).
 *
 * The returned report carries one {@link CaseReport} per case plus an aggregate:
 * the mean of each scorer across all cases (`perScorer`) and the mean of the
 * per-case averages (`overall`).
 *
 * @param dataset The cases to grade.
 * @param run     Produces the output string for a given input.
 * @param scorers A name → scorer map; the names key the per-scorer aggregate.
 */
export async function evaluate(
  dataset: readonly EvalCase[],
  run: (input: string) => Awaitable<string>,
  scorers: Record<string, Scorer>,
): Promise<EvalReport> {
  const cases = await Promise.all(
    dataset.map(async (testCase): Promise<CaseReport> => {
      const output = await run(testCase.input);
      const sample: ScorerInput = { input: testCase.input, output };

      if (testCase.expected !== undefined) {
        sample.expected = testCase.expected;
      }
      if (testCase.metadata !== undefined) {
        sample.metadata = testCase.metadata;
      }

      const scores = await gradeSample(sample, scorers);
      const average = arithmeticMean(Object.values(scores).map((verdict) => verdict.score));

      return { input: testCase.input, output, scores, average };
    }),
  );

  const perScorer: Record<string, number> = {};

  for (const name of Object.keys(scorers)) {
    perScorer[name] = arithmeticMean(cases.map((report) => report.scores[name]?.score ?? 0));
  }

  const overall = arithmeticMean(cases.map((report) => report.average));

  return { cases, aggregate: { perScorer, overall } };
}
