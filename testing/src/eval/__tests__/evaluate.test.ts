import { describe, it, expect, expectTypeOf } from 'vitest';
import { evaluate } from '../evaluate.js';
import { contains, exactMatch } from '../scorers.js';
import type { EvalCase, EvalReport, Scorer } from '../types.js';

describe('evaluate', () => {
  it('produces a per-case report and an aggregate', async () => {
    const report = await evaluate([{ input: 'say hi', expected: 'hi' }], async () => 'hi', {
      exact: exactMatch(),
    });

    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]?.input).toBe('say hi');
    expect(report.cases[0]?.output).toBe('hi');
    expect(report.cases[0]?.scores.exact).toEqual({ score: 1 });
    expect(report.cases[0]?.average).toBe(1);
    expect(report.aggregate.perScorer.exact).toBe(1);
    expect(report.aggregate.overall).toBe(1);
  });

  it('computes per-scorer means and the overall mean across cases', async () => {
    const report = await evaluate(
      [{ input: 'a' }, { input: 'b' }],
      (input) => (input === 'a' ? 'foo' : 'bar'),
      {
        always: () => 1,
        half: ({ output }) => (output === 'foo' ? 0 : 0.5),
      },
    );

    // case a → foo: always=1, half=0  → average 0.5
    // case b → bar: always=1, half=.5 → average 0.75
    expect(report.cases[0]?.average).toBe(0.5);
    expect(report.cases[1]?.average).toBe(0.75);
    expect(report.aggregate.perScorer.always).toBe(1);
    expect(report.aggregate.perScorer.half).toBe(0.25);
    expect(report.aggregate.overall).toBe(0.625);
  });

  it('normalizes and clamps raw scorer numbers', async () => {
    const report = await evaluate([{ input: 'x' }], () => 'out', {
      over: () => 5,
      under: () => -3,
      nan: () => Number.NaN,
      mid: () => 0.4,
    });

    expect(report.cases[0]?.scores.over).toEqual({ score: 1 });
    expect(report.cases[0]?.scores.under).toEqual({ score: 0 });
    expect(report.cases[0]?.scores.nan).toEqual({ score: 0 });
    expect(report.cases[0]?.scores.mid).toEqual({ score: 0.4 });
    expect(report.cases[0]?.average).toBe((1 + 0 + 0 + 0.4) / 4);
  });

  it('awaits an async producer and async scorers', async () => {
    const report = await evaluate(
      [{ input: 'ping' }],
      async (input) => Promise.resolve(`${input}-pong`),
      { hasPong: async ({ output }) => (output.includes('pong') ? 1 : 0) },
    );

    expect(report.cases[0]?.output).toBe('ping-pong');
    expect(report.aggregate.overall).toBe(1);
  });

  it('forwards input, expected and metadata to scorers', async () => {
    const seen: Array<{ input?: string; expected?: string; meta: unknown }> = [];
    const spy: Scorer = ({ input, expected, metadata }) => {
      seen.push({ input, expected, meta: metadata?.tag });

      return 1;
    };

    await evaluate([{ input: 'q', expected: 'gold', metadata: { tag: 'unit' } }], () => 'a', {
      spy,
    });

    expect(seen).toEqual([{ input: 'q', expected: 'gold', meta: 'unit' }]);
  });

  it('handles an empty dataset by zeroing every scorer aggregate', async () => {
    const report = await evaluate([], () => '', { exact: exactMatch(), has: contains('x') });

    expect(report.cases).toEqual([]);
    expect(report.aggregate.perScorer).toEqual({ exact: 0, has: 0 });
    expect(report.aggregate.overall).toBe(0);
  });

  it('treats a case with no scorers as a zero average', async () => {
    const report = await evaluate([{ input: 'x' }], () => 'out', {});

    expect(report.cases[0]?.scores).toEqual({});
    expect(report.cases[0]?.average).toBe(0);
    expect(report.aggregate.perScorer).toEqual({});
    expect(report.aggregate.overall).toBe(0);
  });
});

describe('evaluate type surface', () => {
  it('accepts a readonly dataset and a name → scorer map', () => {
    expectTypeOf(evaluate).parameter(0).toEqualTypeOf<readonly EvalCase[]>();
    expectTypeOf(evaluate).parameter(2).toEqualTypeOf<Record<string, Scorer>>();
    expectTypeOf(evaluate).returns.resolves.toEqualTypeOf<EvalReport>();
  });

  it('accepts a sync or async producer', () => {
    expectTypeOf(evaluate([], syncProducer, {})).resolves.toEqualTypeOf<EvalReport>();
    expectTypeOf(evaluate([], asyncProducer, {})).resolves.toEqualTypeOf<EvalReport>();
  });
});

const syncProducer = (input: string): string => input;
const asyncProducer = async (input: string): Promise<string> => input;
