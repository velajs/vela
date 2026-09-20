import { describe, expect, it } from 'vitest';

import {
  LIVE_EVENT,
  MAX_LIVE_FRAME_BYTES,
  encodeLiveEnvelope,
  encodeLiveFrame,
  isClientLiveFrame,
  isRowOp,
  isRowOps,
  isServerLiveFrame,
  liveEnvelope,
  readLiveEnvelope,
} from '../frames';
import { LIVE_PROTOCOL } from '../version';

describe('envelope', () => {
  it('reserves the $live event', () => {
    expect(LIVE_EVENT).toBe('$live');
  });

  it('extracts the frame from a live envelope and nothing else', () => {
    expect(readLiveEnvelope({ event: '$live', data: { t: 'ack', sub: 's1' } })).toEqual({
      t: 'ack',
      sub: 's1',
    });
    expect(readLiveEnvelope({ event: 'chat.message', data: {} })).toBeUndefined();
    expect(readLiveEnvelope('not an envelope')).toBeUndefined();
  });

  it('round-trips through liveEnvelope', () => {
    const frame = { t: 'unsub', sub: 's1' } as const;
    expect(readLiveEnvelope(JSON.parse(JSON.stringify(liveEnvelope(frame))))).toEqual(frame);
  });

  it('encodes optionals only when present', () => {
    expect(encodeLiveEnvelope({ t: 'settled', sub: 's1' })).toBe(
      '{"event":"$live","data":{"t":"settled","sub":"s1"}}',
    );
  });

  it('refuses to encode malformed or oversized outbound frames', () => {
    expect(() =>
      encodeLiveFrame({ t: 'data', sub: 's1', snapshot: [], cursor: 1 } as never),
    ).toThrow(/invalid or oversized/);
    expect(() => encodeLiveFrame({ t: 'presence', room: 'r', meta: 'x'.repeat(5000) })).toThrow(
      /invalid or oversized/,
    );

    const emptyFrame = {
      t: 'data',
      sub: 's1',
      snapshot: '',
      cursor: 1,
      epoch: 'e',
    } as const;
    const emptyFrameBytes = new TextEncoder().encode(encodeLiveFrame(emptyFrame)).byteLength;
    const envelopeOnlyOversized = {
      ...emptyFrame,
      snapshot: 'x'.repeat(MAX_LIVE_FRAME_BYTES - emptyFrameBytes),
    };
    expect(new TextEncoder().encode(encodeLiveFrame(envelopeOnlyOversized)).byteLength).toBe(
      MAX_LIVE_FRAME_BYTES,
    );
    expect(() => encodeLiveEnvelope(envelopeOnlyOversized)).toThrow(/oversized live envelope/);
  });
});

describe('guards', () => {
  it('rejects unknown frame types (forward-compat: receiver ignores)', () => {
    expect(isClientLiveFrame({ t: 'future-thing', sub: 's1' })).toBe(false);
    expect(isServerLiveFrame({ t: 'future-thing', sub: 's1' })).toBe(false);
  });

  it('tolerates bounded JSON-compatible extra fields on known frames', () => {
    expect(isServerLiveFrame({ t: 'ack', sub: 's1', futureField: 1 })).toBe(true);
    expect(isClientLiveFrame({ t: 'unsub', sub: 's1', futureField: 1 })).toBe(true);
  });

  it('rejects malformed cursors, incomplete watermarks, and oversized frames', () => {
    expect(isServerLiveFrame({ t: 'resume', sub: 's1', cursor: -1, epoch: 'e' })).toBe(false);
    expect(isServerLiveFrame({ t: 'data', sub: 's1', snapshot: [], cursor: 1 })).toBe(false);
    expect(
      isClientLiveFrame({
        t: 'sub',
        sub: 's1',
        query: 'q',
        args: 'x'.repeat(70 * 1024),
        v: LIVE_PROTOCOL,
      }),
    ).toBe(false);
    expect(isClientLiveFrame({ t: 'presence', room: 'r', meta: { value: 'x'.repeat(5000) } })).toBe(
      false,
    );
  });

  it('rejects inherited/prototype payloads and unsupported protocol versions', () => {
    const inherited = Object.create({ snapshot: [] }) as Record<string, unknown>;
    Object.assign(inherited, { t: 'data', sub: 's1' });
    expect(isServerLiveFrame(inherited)).toBe(false);
    expect(isClientLiveFrame({ t: 'sub', sub: 's1', query: 'q', v: 999 })).toBe(false);
    expect(isClientLiveFrame({ t: 'sub', sub: 's1', query: 'q' })).toBe(false);
    expect(
      isClientLiveFrame(
        JSON.parse(
          `{"t":"sub","sub":"s1","query":"q","v":${LIVE_PROTOCOL},"args":{"__proto__":{}}}`,
        ),
      ),
    ).toBe(false);
  });

  it('requires resume to carry cursor and epoch', () => {
    expect(isServerLiveFrame({ t: 'resume', sub: 's1', cursor: 1, epoch: 'e' })).toBe(true);
    expect(isServerLiveFrame({ t: 'resume', sub: 's1' })).toBe(false);
  });

  it('rejects object and array accessors without executing application code', () => {
    let reads = 0;
    const payload = {
      get value(): never {
        reads += 1;
        throw new Error('getter must not run');
      },
    };
    const array: unknown[] = [];
    Object.defineProperty(array, 0, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('getter must not run');
      },
    });

    expect(isServerLiveFrame({ t: 'data', sub: 's1', snapshot: payload })).toBe(false);
    expect(isServerLiveFrame({ t: 'data', sub: 's1', snapshot: array })).toBe(false);
    expect(reads).toBe(0);
  });

  it('uses the same inert JSON boundary for standalone row operation guards', () => {
    let reads = 0;
    const operation = {
      op: 'delete',
      get key(): never {
        reads += 1;
        throw new Error('getter must not run');
      },
    };

    expect(isRowOp(operation)).toBe(false);
    expect(isRowOps([operation])).toBe(false);
    expect(reads).toBe(0);
  });

  it('rejects values whose JSON representation hides or changes own properties', () => {
    const frame = { t: 'data', sub: 's1' };
    Object.defineProperty(frame, 'snapshot', { value: [] });
    const customArray = Object.assign([], { toJSON: () => 'different payload' });
    const sparseArray: unknown[] = [];
    sparseArray.length = 2;

    expect(isServerLiveFrame(frame)).toBe(false);
    expect(isServerLiveFrame({ t: 'data', sub: 's1', snapshot: customArray })).toBe(false);
    expect(isServerLiveFrame({ t: 'data', sub: 's1', snapshot: sparseArray })).toBe(false);
    expect(isServerLiveFrame({ t: 'data', sub: 's1', snapshot: { [Symbol('hidden')]: 1 } })).toBe(
      false,
    );
  });

  it('validates delta ops structurally', () => {
    expect(isServerLiveFrame({ t: 'delta', sub: 's1', ops: [{ op: 'delete', key: 'a' }] })).toBe(
      true,
    );
    expect(
      isServerLiveFrame({ t: 'delta', sub: 's1', ops: [{ op: 'insert', key: 'a', row: {} }] }),
    ).toBe(false); // missing before
    expect(isServerLiveFrame({ t: 'delta', sub: 's1', ops: [{ op: 'nope', key: 'a' }] })).toBe(
      false,
    );
  });
});
