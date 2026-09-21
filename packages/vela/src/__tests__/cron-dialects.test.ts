import { describe, expect, it } from 'vitest';
import { parseCron, type CronOptions } from '../schedule/cron-matcher';
import { parseCronMetadata, parseIntervalMetadata } from '../schedule/schedule.metadata';

const matches = (expression: string, date: string, options: CronOptions = { timeZone: 'UTC' }) =>
  parseCron(expression, options)?.(new Date(date));
const cf: CronOptions = { dialect: 'cloudflare' };

describe('explicit cron dialects', () => {
  it('retains local time by default and supports explicit UTC', () => {
    const local = new Date(2024, 0, 1, 9, 30);
    expect(parseCron('30 9 * * *')?.(local)).toBe(true);
    expect(matches('30 9 * * *', '2024-01-01T09:30:00Z')).toBe(true);
    expect(matches('30 9 * * *', '2024-01-01T10:30:00Z')).toBe(false);
    expect(parseCron('* * * * *')?.(new Date(NaN))).toBe(false);
    expect(parseCron('* * * * *', { dialect: 'cloudflare', timeZone: 'local' })).toBeNull();
  });

  it('retains conjunctive legacy day fields', () => {
    expect(matches('0 0 1 * 1', '2024-01-01T00:00:00Z')).toBe(true);
    expect(matches('0 0 1 * 1', '2024-01-08T00:00:00Z')).toBe(false);
  });

  it('matches either restricted native day field and keeps bare wildcards unrestricted', () => {
    expect(matches('0 0 1 * MON', '2024-01-08T00:00:00Z', cf)).toBe(true);
    expect(matches('0 0 1 * MON', '2024-02-01T00:00:00Z', cf)).toBe(true);
    expect(matches('0 0 1 * MON', '2024-02-02T00:00:00Z', cf)).toBe(false);
    expect(matches('0 0 * * MON', '2024-02-02T00:00:00Z', cf)).toBe(false);
    expect(matches('0 0 1 * *', '2024-02-02T00:00:00Z', cf)).toBe(false);
    expect(matches('0 0 */1 * MON', '2024-02-02T00:00:00Z', cf)).toBe(true);
  });

  it('supports native wrap-around ranges and continues steps across the boundary', () => {
    expect(parseCron('5-2 0 * * *')).toBeNull();
    expect(matches('55-5/5 20-4/2 * NOV-FEB FRI-MON', '2024-01-01T02:00:00Z', cf)).toBe(true);
    expect(matches('55-5/5 20-4/2 * NOV-FEB FRI-MON', '2024-01-01T02:05:00Z', cf)).toBe(true);
    expect(matches('55-5/5 20-4/2 * NOV-FEB FRI-MON', '2024-01-01T02:10:00Z', cf)).toBe(false);
    expect(matches('55-5/5 20-4/2 * NOV-FEB FRI-MON', '2024-01-01T03:00:00Z', cf)).toBe(false);
    expect(matches('0 0 30-2 * *', '2024-01-01T00:00:00Z', cf)).toBe(true);
    expect(matches('0 0 30-2 * *', '2024-01-03T00:00:00Z', cf)).toBe(false);
  });

  it('validates native step limits and wildcard list syntax', () => {
    for (const expression of [
      '*/60 * * * *',
      '* */24 * * *',
      '* * */31 * *',
      '* * * */12 *',
      '* * * * */7',
      '*,1 * * * *',
    ]) {
      expect(parseCron(expression, cf)).toBeNull();
    }
    expect(matches('*/59 */23 */30 */11 */6', '2024-01-01T00:59:00Z', cf)).toBe(true);
    expect(matches('*/15,*/20 * * * *', '2024-01-01T00:20:00Z', cf)).toBe(true);
    expect(matches('15,* * * * *', '2024-01-01T00:00:00Z', cf)).toBe(true);
    expect(matches('15,* * * * *', '2024-01-01T00:10:00Z', cf)).toBe(false);
  });

  it('keeps Sunday aliases in Unix ranges without changing native weekdays', () => {
    expect(matches('0 0 * * 5-7', '2024-01-07T00:00:00Z')).toBe(true);
    expect(matches('0 0 * * 5-7', '2024-01-05T00:00:00Z')).toBe(true);
    expect(matches('0 0 * * 5-7', '2024-01-08T00:00:00Z')).toBe(false);
    expect(matches('0 0 * * 1', '2024-01-08T00:00:00Z')).toBe(true);
    expect(matches('0 0 * * 1', '2024-01-07T00:00:00Z', cf)).toBe(true);
    expect(matches('0 0 * * 7', '2024-01-06T00:00:00Z', cf)).toBe(true);
    expect(parseCron('0 0 * * 0', cf)).toBeNull();
  });

  it('supports named months, weekdays, ranges, lists and start/step', () => {
    expect(matches('5/15 9 * jan MON-FRI', '2024-01-08T09:20:00Z')).toBe(true);
    expect(matches('5/15 9 * jan MON-FRI', '2024-01-08T09:15:00Z')).toBe(false);
    expect(matches('0,30 9 * JAN,MAR MON-FRI', '2024-03-08T09:30:00Z', cf)).toBe(true);
  });

  it.each([
    ['0 0 L * *', '2024-02-29T00:00:00Z', true],
    ['0 0 L * *', '2024-02-28T00:00:00Z', false],
    ['0 0 LW * *', '2024-03-29T00:00:00Z', true],
    ['0 0 L-3 * *', '2024-02-26T00:00:00Z', true],
    ['0 0 L-3 * *', '2024-02-25T00:00:00Z', false],
    ['0 0 L-30 * *', '2024-02-01T00:00:00Z', false],
    ['0 0 L-30 * *', '2024-01-01T00:00:00Z', true],
    ['0 0 L-3W * *', '2024-03-28T00:00:00Z', true],
    ['0 0 L-1W * *', '2024-03-29T00:00:00Z', true],
    ['0 0 L-30W * *', '2021-05-03T00:00:00Z', true],
    ['0 0 L-30W * *', '2024-02-01T00:00:00Z', false],
    ['0 0 1W * *', '2024-06-03T00:00:00Z', true],
    ['0 0 31W * *', '2024-03-29T00:00:00Z', true],
    ['0 0 31W * *', '2024-04-30T00:00:00Z', false],
    ['0 0 * * 6L', '2024-03-29T00:00:00Z', true],
    ['0 0 * * friL', '2024-03-22T00:00:00Z', false],
    ['0 0 * * mon#2', '2024-01-08T00:00:00Z', true],
    ['0 0 * * 2#5', '2024-01-29T00:00:00Z', true],
    ['0 0 * * 2#02', '2024-01-08T00:00:00Z', true],
    ['0 0 * * L', '2024-01-06T00:00:00Z', true],
  ])('matches Cloudflare calendar expression %s at %s', (expression, date, expected) => {
    expect(matches(expression, date, cf)).toBe(expected);
  });

  it.each([
    '0x10 0 * * *',
    '1e1 0 * * *',
    '+1 0 * * *',
    '1.5 0 * * *',
    '/5 0 * * *',
    '*/0 0 * * *',
    '*/ 0 * * *',
    ',1 0 * * *',
    '1, 0 * * *',
    '1- 0 * * *',
    '60 0 * * *',
    '* * * * * *',
    '0 0 0W * *',
    '0 0 L-0 * *',
    '0 0 L-31 * *',
    '0 0 L-3,W * *',
    '0 0 * * 2#0',
    '0 0 * * 2#6',
  ])('rejects malformed cron %s', (expression) => {
    expect(parseCron(expression, cf)).toBeNull();
    expect(parseCron(expression)).toBeNull();
  });
});

describe('deployment-safe schedule metadata', () => {
  it('preserves exact cron trigger strings, deferring unspecified dialect to the adapter', () => {
    expect(parseCronMetadata({ expression: '0  0 LW * *', methodName: 'tick' })).toEqual({
      expression: '0  0 LW * *',
      methodName: 'tick',
    });
    expect(() =>
      parseCronMetadata({ expression: '0 0 * * 0', dialect: 'cloudflare', methodName: 'tick' }),
    ).toThrow();
    expect(() =>
      parseCronMetadata({ expression: '* * * * *', timeZone: 'Mars', methodName: 'tick' }),
    ).toThrow();
  });
  it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648, '100'])(
    'rejects an unsafe interval %s',
    (ms) => {
      expect(() => parseIntervalMetadata({ ms, methodName: 'tick' })).toThrow();
    },
  );
  it('accepts the supported timer bounds', () => {
    expect(parseIntervalMetadata({ ms: 1, methodName: 'tick' }).ms).toBe(1);
    expect(parseIntervalMetadata({ ms: 2_147_483_647, methodName: 'tick' }).ms).toBe(2_147_483_647);
  });
});
