import { describe, expect, it } from 'vitest';

import {
  LIVE_EVENT,
  MAX_LIVE_FRAME_BYTES,
  MAX_PRESENCE_METADATA_BYTES,
  encodeLiveFrame,
  isClientLiveFrame,
  isServerLiveFrame,
  readLiveEnvelope,
} from '../frames';
import { LIVE_PROTOCOL } from '../version';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[next() % values.length]!;
}

function randomText(next: () => number, alphabet: string, maxLength: number): string {
  const length = next() % (maxLength + 1);
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[next() % alphabet.length];
  }
  return value;
}

function nestedDangerousPayload(
  key: '__proto__' | 'constructor' | 'prototype',
  depth: number,
): unknown {
  const leaf = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(leaf, key, { value: { polluted: true }, enumerable: true });
  let value: unknown = leaf;
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
}

describe('security property sweep — realtime frame cursors and schemas', () => {
  it('rejects randomized invalid cursors and incomplete cursor/epoch pairs', () => {
    const next = seeded(0xc025_0250);
    const invalidCursors: readonly unknown[] = [
      -1,
      -0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      null,
      {},
      [],
    ];

    for (let sample = 0; sample < 500; sample += 1) {
      const cursor = pick(next, invalidCursors);
      expect(
        isClientLiveFrame({
          t: 'sub',
          sub: `s-${sample}`,
          query: 'messages.list',
          sinceCursor: cursor,
          sinceEpoch: 'epoch-1',
          v: LIVE_PROTOCOL,
        }),
      ).toBe(false);
      expect(
        isServerLiveFrame({
          t: 'data',
          sub: `s-${sample}`,
          snapshot: [],
          cursor,
          epoch: 'epoch-1',
        }),
      ).toBe(false);
      expect(isServerLiveFrame({ t: 'resume', sub: `s-${sample}`, cursor, epoch: 'epoch-1' })).toBe(
        false,
      );

      const incompleteClient =
        sample % 2 === 0
          ? { t: 'sub', sub: 's', query: 'q', sinceCursor: next() % 100, v: LIVE_PROTOCOL }
          : { t: 'sub', sub: 's', query: 'q', sinceEpoch: 'epoch-1', v: LIVE_PROTOCOL };
      const incompleteServer =
        sample % 2 === 0
          ? { t: 'settled', sub: 's', cursor: next() % 100 }
          : { t: 'settled', sub: 's', epoch: 'epoch-1' };
      expect(isClientLiveFrame(incompleteClient)).toBe(false);
      expect(isServerLiveFrame(incompleteServer)).toBe(false);
    }
  });

  it('rejects randomized oversized identifiers, payloads, presence, and envelopes', () => {
    const next = seeded(0x51ce_b00f);

    for (let sample = 0; sample < 300; sample += 1) {
      const overflow = 1 + (next() % 512);
      expect(
        isClientLiveFrame({
          t: 'presence',
          room: 'room-1',
          meta: 'x'.repeat(MAX_PRESENCE_METADATA_BYTES + overflow),
        }),
      ).toBe(false);
      expect(
        isClientLiveFrame({
          t: 'sub',
          sub: 's',
          query: 'q',
          args: 'x'.repeat(32 * 1024 + overflow),
          v: LIVE_PROTOCOL,
        }),
      ).toBe(false);
      expect(
        isServerLiveFrame({
          t: 'error',
          code: 'bad_args',
          message: 'x'.repeat(2048 + overflow),
          fatal: false,
        }),
      ).toBe(false);
      expect(
        readLiveEnvelope({
          event: LIVE_EVENT,
          data: 'x'.repeat(MAX_LIVE_FRAME_BYTES + overflow),
        }),
      ).toBeUndefined();
    }
  });
});

describe('security property sweep — realtime JSON boundaries', () => {
  it('rejects dangerous object keys at randomized nesting depths', () => {
    const next = seeded(0xd4a6_e205);
    const dangerous = ['__proto__', 'constructor', 'prototype'] as const;

    for (let sample = 0; sample < 400; sample += 1) {
      const payload = nestedDangerousPayload(pick(next, dangerous), next() % 30);
      expect(
        isClientLiveFrame({
          t: 'sub',
          sub: 's',
          query: 'q',
          args: payload,
          v: LIVE_PROTOCOL,
        }),
      ).toBe(false);
      expect(isServerLiveFrame({ t: 'data', sub: 's', snapshot: payload })).toBe(false);
    }
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('rejects cyclic payloads and over-depth payloads without throwing', () => {
    const next = seeded(0xc1cc_1e55);

    for (let sample = 0; sample < 300; sample += 1) {
      const cyclic: Record<string, unknown> = { seed: next() };
      cyclic.self = cyclic;
      let tooDeep: unknown = { leaf: sample };
      for (let depth = 0; depth < 34 + (next() % 16); depth += 1) tooDeep = { value: tooDeep };

      expect(
        isClientLiveFrame({ t: 'sub', sub: 's', query: 'q', args: cyclic, v: LIVE_PROTOCOL }),
      ).toBe(false);
      expect(isServerLiveFrame({ t: 'data', sub: 's', snapshot: tooDeep })).toBe(false);
    }
  });

  it('ignores randomized unknown frame and envelope discriminators', () => {
    const next = seeded(0xf07a_4d5);

    for (let sample = 0; sample < 500; sample += 1) {
      const discriminator = `future-${randomText(next, 'abcdefghijklmnopqrstuvwxyz0123456789', 32)}`;
      const frame = { t: discriminator, sub: `s-${sample}`, payload: { seed: next() } };
      expect(isClientLiveFrame(frame)).toBe(false);
      expect(isServerLiveFrame(frame)).toBe(false);
      expect(readLiveEnvelope({ event: `$${discriminator}`, data: frame })).toBeUndefined();
      expect(() => encodeLiveFrame(frame as never)).toThrow(TypeError);
    }
  });
});
