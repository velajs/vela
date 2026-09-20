/**
 * `@velajs/testing/eval` — a small, model-agnostic harness for scoring the
 * output of any string-producing function (an LLM turn, an agent loop, a
 * formatter, …) against heuristics or an injected LLM judge.
 *
 * Grade one output with a {@link Scorer}, or run a whole dataset through
 * {@link evaluate} for per-case and aggregate scores. The package pulls in no
 * AI SDK: the only LLM touchpoint is {@link llmScorer}, whose `judge` is a
 * plain callback you supply.
 *
 * @example
 * ```ts
 * import { evaluate, keyword, llmScorer } from '@velajs/testing/eval';
 *
 * const report = await evaluate(
 *   [{ input: 'where is my order?', expected: 'shipped' }],
 *   async (input) => askSupportAgent(input),
 *   {
 *     coverage: keyword(['shipped']),
 *     helpful: llmScorer({ criteria: 'answers the question', judge: myModel }),
 *   },
 * );
 *
 * expect(report.aggregate.overall).toBeGreaterThan(0.5);
 * ```
 */

export {
  contains,
  exactMatch,
  keyword,
  llmScorer,
  regex,
  renderJudgePrompt,
  parseJudgeReply,
} from './scorers.js';
export type {
  ContainsOptions,
  ExactMatchOptions,
  KeywordOptions,
  LlmScorerOptions,
} from './scorers.js';
export { evaluate } from './evaluate.js';
export type {
  Awaitable,
  CaseReport,
  EvalAggregate,
  EvalCase,
  EvalReport,
  Scorer,
  ScorerInput,
  ScoreResult,
} from './types.js';
