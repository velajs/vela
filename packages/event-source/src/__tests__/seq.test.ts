import { describe, expect, it } from 'vitest';
import { isClientSeq, isGlobalSeq, isInputEvent, type ClientSeq, type InputEvent } from '../index';

describe('seq guards', () => {
  it('isGlobalSeq matches numbers only', () => {
    expect(isGlobalSeq(0)).toBe(true);
    expect(isGlobalSeq(42)).toBe(true);
    expect(isGlobalSeq({ client: 1, global: 0, rebaseGeneration: 0 })).toBe(false);
  });

  it('isClientSeq matches the composite shape via its rebaseGeneration field', () => {
    const clientSeq: ClientSeq = { client: 3, global: 7, rebaseGeneration: 1 };
    expect(isClientSeq(clientSeq)).toBe(true);
    expect(isClientSeq(9)).toBe(false);
  });

  it('ClientSeq reserves rebaseGeneration for forward-compat', () => {
    const seq: ClientSeq = { client: 0, global: 0, rebaseGeneration: 0 };
    expect(seq.rebaseGeneration).toBe(0);
  });

  it('isInputEvent requires type/payload/timestamp', () => {
    const event: InputEvent<'x', number> = { type: 'x', payload: 1, timestamp: 100 };
    expect(isInputEvent(event)).toBe(true);
    expect(isInputEvent({ type: 'x', payload: 1 })).toBe(false);
    expect(isInputEvent({ payload: 1, timestamp: 100 })).toBe(false);
    expect(isInputEvent(null)).toBe(false);
    expect(isInputEvent('nope')).toBe(false);
  });
});
