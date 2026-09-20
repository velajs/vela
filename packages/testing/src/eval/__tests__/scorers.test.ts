import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  contains,
  exactMatch,
  keyword,
  llmScorer,
  regex,
  renderJudgePrompt,
  parseJudgeReply,
} from '../scorers.js';
import type { Scorer, ScoreResult, ScorerInput } from '../types.js';

/** Resolve a scorer to its normalized-ish output for terser assertions. */
async function grade(scorer: Scorer, sample: ScorerInput): Promise<number | ScoreResult> {
  return scorer(sample);
}

describe('exactMatch', () => {
  it('scores 1 for a trimmed exact match', async () => {
    expect(await grade(exactMatch(), { output: '  hello  ', expected: 'hello' })).toBe(1);
  });

  it('scores 0 for a mismatch', async () => {
    expect(await grade(exactMatch(), { output: 'hello', expected: 'goodbye' })).toBe(0);
  });

  it('is case-sensitive by default', async () => {
    expect(await grade(exactMatch(), { output: 'Hello', expected: 'hello' })).toBe(0);
  });

  it('can compare case-insensitively', async () => {
    expect(
      await grade(exactMatch({ caseSensitive: false }), { output: 'Hello', expected: 'hello' }),
    ).toBe(1);
  });

  it('can keep surrounding whitespace significant', async () => {
    expect(await grade(exactMatch({ trim: false }), { output: ' hi ', expected: 'hi' })).toBe(0);
  });

  it('fails closed when there is no expected value', async () => {
    expect(await grade(exactMatch(), { output: 'anything' })).toEqual({
      score: 0,
      reason: 'no expected value to compare against',
    });
  });
});

describe('contains', () => {
  it('scores 1 when a single needle is present (case-insensitive default)', async () => {
    expect(await grade(contains('Ship'), { output: 'it shipped tuesday' })).toBe(1);
  });

  it('scores 0 when the needle is absent', async () => {
    expect(await grade(contains('refund'), { output: 'it shipped tuesday' })).toBe(0);
  });

  it('honors case sensitivity', async () => {
    expect(await grade(contains('Ship', { caseSensitive: true }), { output: 'it shipped' })).toBe(
      0,
    );
  });

  it('requires every needle in all-of mode (the default)', async () => {
    const scorer = contains(['ship', 'tuesday']);

    expect(await grade(scorer, { output: 'shipped tuesday' })).toBe(1);
    expect(await grade(scorer, { output: 'shipped monday' })).toBe(0);
  });

  it('requires only one needle in any-of mode', async () => {
    const scorer = contains(['ship', 'deliver'], { mode: 'any' });

    expect(await grade(scorer, { output: 'delivered friday' })).toBe(1);
    expect(await grade(scorer, { output: 'cancelled' })).toBe(0);
  });

  it('throws on an empty needle list', () => {
    expect(() => contains([])).toThrow(/at least one needle/u);
  });
});

describe('keyword', () => {
  it('scores the fraction of keywords present', async () => {
    const result = await grade(keyword(['ship', 'tuesday', 'tracking']), {
      output: 'shipped tuesday',
    });

    expect(result).toEqual({ score: 2 / 3, reason: '2/3 keywords present' });
  });

  it('scores 1 when all keywords appear', async () => {
    const result = await grade(keyword(['a', 'b']), { output: 'a and b' });

    expect(result).toEqual({ score: 1, reason: '2/2 keywords present' });
  });

  it('scores 0 when none appear', async () => {
    const result = await grade(keyword(['x', 'y']), { output: 'nothing here' });

    expect(result).toEqual({ score: 0, reason: '0/2 keywords present' });
  });

  it('is case-insensitive by default', async () => {
    const result = await grade(keyword(['SHIP']), { output: 'it shipped' });

    expect(result).toEqual({ score: 1, reason: '1/1 keywords present' });
  });

  it('throws on an empty keyword list', () => {
    expect(() => keyword([])).toThrow(/at least one keyword/u);
  });
});

describe('regex', () => {
  it('scores 1 on a match and 0 otherwise', async () => {
    const scorer = regex(/order #\d+/u);

    expect(await grade(scorer, { output: 'your order #42 shipped' })).toBe(1);
    expect(await grade(scorer, { output: 'no order here' })).toBe(0);
  });

  it('is stable across reuse even for a global-flagged pattern', async () => {
    // A raw /g regex advances lastIndex between .test() calls, which would make
    // a reused scorer alternate 1/0. The scorer must strip that statefulness.
    const scorer = regex(/\d+/gu);

    expect(await grade(scorer, { output: 'has 7 items' })).toBe(1);
    expect(await grade(scorer, { output: 'has 7 items' })).toBe(1);
    expect(await grade(scorer, { output: 'has 7 items' })).toBe(1);
  });
});

describe('renderJudgePrompt', () => {
  it('includes the criterion and the output', () => {
    const prompt = renderJudgePrompt('is polite', { output: 'thank you!' });

    expect(prompt).toContain('Criterion: is polite');
    expect(prompt).toContain('Output to grade: thank you!');
  });

  it('folds in input and expected when present', () => {
    const prompt = renderJudgePrompt('accurate', { input: 'q?', expected: 'a', output: 'a' });

    expect(prompt).toContain('Prompt: q?');
    expect(prompt).toContain('Expected answer: a');
  });

  it('omits input and expected when absent', () => {
    const prompt = renderJudgePrompt('accurate', { output: 'a' });

    expect(prompt).not.toContain('Prompt:');
    expect(prompt).not.toContain('Expected answer:');
  });
});

describe('parseJudgeReply', () => {
  it('reads a leading decimal and keeps the reply as the reason', () => {
    expect(parseJudgeReply('0.8 - mostly correct')).toEqual({
      score: 0.8,
      reason: '0.8 - mostly correct',
    });
  });

  it('clamps a leading value above 1', () => {
    expect(parseJudgeReply('5 great')).toEqual({ score: 1, reason: '5 great' });
  });

  it('clamps a negative leading value to 0', () => {
    expect(parseJudgeReply('-2 terrible')).toEqual({ score: 0, reason: '-2 terrible' });
  });

  it('fails soft to 0 when there is no leading number', () => {
    // A number buried mid-reply (here "step 3") must not be read as the grade.
    expect(parseJudgeReply('looks correct to me (see step 3)')).toEqual({
      score: 0,
      reason: 'looks correct to me (see step 3)',
    });
  });
});

describe('llmScorer', () => {
  it('grades using the injected judge', async () => {
    const scorer = llmScorer({
      criteria: 'answers the question',
      judge: async () => '0.9 - solid',
    });

    expect(await grade(scorer, { input: 'q?', output: 'a' })).toEqual({
      score: 0.9,
      reason: '0.9 - solid',
    });
  });

  it('passes the built prompt to the judge', async () => {
    let seen = '';
    const scorer = llmScorer({
      criteria: 'is concise',
      judge: async (prompt) => {
        seen = prompt;

        return '1';
      },
    });

    await grade(scorer, { input: 'hi', expected: 'hey', output: 'hey' });

    expect(seen).toContain('Criterion: is concise');
    expect(seen).toContain('Prompt: hi');
    expect(seen).toContain('Expected answer: hey');
    expect(seen).toContain('Output to grade: hey');
  });

  it('fails soft when the judge reply has no leading number', async () => {
    const scorer = llmScorer({
      criteria: 'anything',
      judge: async () => 'I think it is good',
    });

    expect(await grade(scorer, { output: 'x' })).toEqual({
      score: 0,
      reason: 'I think it is good',
    });
  });
});

describe('scorer type surface', () => {
  it('exposes factories that return the exported Scorer type', () => {
    expectTypeOf(exactMatch()).toEqualTypeOf<Scorer>();
    expectTypeOf(contains('x')).toEqualTypeOf<Scorer>();
    expectTypeOf(keyword(['x'])).toEqualTypeOf<Scorer>();
    expectTypeOf(regex(/x/u)).toEqualTypeOf<Scorer>();
    expectTypeOf(llmScorer({ criteria: 'c', judge: async () => '1' })).toEqualTypeOf<Scorer>();
  });

  it('lets a user-authored scorer satisfy the Scorer type', () => {
    expectTypeOf(customScorer).parameter(0).toEqualTypeOf<ScorerInput>();
    expectTypeOf(reasonedScorer).returns.resolves.toEqualTypeOf<number | ScoreResult>();
    expectTypeOf(asyncScorer).returns.resolves.toEqualTypeOf<number | ScoreResult>();
  });
});

const customScorer: Scorer = ({ output }) => (output.length > 0 ? 1 : 0);
const reasonedScorer: Scorer = ({ output }) => ({
  score: output.length > 0 ? 1 : 0,
  reason: 'len check',
});
const asyncScorer: Scorer = async ({ output }) => output.length;
