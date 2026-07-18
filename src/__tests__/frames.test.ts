import { describe, expect, it } from 'vitest';

import {
  LIVE_EVENT,
  encodeLiveEnvelope,
  encodeLiveFrame,
  isClientLiveFrame,
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
