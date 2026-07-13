import { describe, expect, it } from 'vitest';

import {
  LIVE_EVENT,
  encodeLiveEnvelope,
  isClientLiveFrame,
  isServerLiveFrame,
  liveEnvelope,
  readLiveEnvelope,
} from '../frames';

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
});

describe('guards', () => {
  it('rejects unknown frame types (forward-compat: receiver ignores)', () => {
    expect(isClientLiveFrame({ t: 'future-thing', sub: 's1' })).toBe(false);
    expect(isServerLiveFrame({ t: 'future-thing', sub: 's1' })).toBe(false);
  });

  it('tolerates unknown extra fields on known frames', () => {
    expect(isServerLiveFrame({ t: 'ack', sub: 's1', futureField: 1 })).toBe(true);
    expect(isClientLiveFrame({ t: 'unsub', sub: 's1', futureField: 1 })).toBe(true);
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
