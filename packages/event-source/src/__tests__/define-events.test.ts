import { describe, expect, it } from 'vitest';
import { defineEvents, payload, type InputEvent } from '../index';

// A stand-in Standard Schema validator — enough surface for structural payload
// inference without pulling in a real validator library.
interface StdSchema<Output> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: Output; readonly output: Output };
  };
}
const stdSchema = <Output>(): StdSchema<Output> => ({
  '~standard': { version: 1, vendor: 'test' },
});

describe('defineEvents', () => {
  const events = defineEvents({
    chat: {
      messageSent: stdSchema<{ channelId: string; text: string }>(),
      messageDeleted: payload<{ messageId: string }>(),
    },
    system: {
      userLoggedIn: stdSchema<{ userId: string }>(),
    },
  });

  it('builds factories that stamp a qualified type, payload, and timestamp', () => {
    const before = Date.now();
    const event = events.chat.messageSent({ channelId: 'c1', text: 'hi' });
    expect(event.type).toBe('chat.messageSent');
    expect(event.payload).toEqual({ channelId: 'c1', text: 'hi' });
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('exposes the qualified type on the factory itself', () => {
    expect(events.chat.messageDeleted.type).toBe('chat.messageDeleted');
    expect(events.system.userLoggedIn.type).toBe('system.userLoggedIn');
  });

  it('supports schema-less payload markers', () => {
    const event = events.chat.messageDeleted({ messageId: 'm1' });
    expect(event).toMatchObject({ type: 'chat.messageDeleted', payload: { messageId: 'm1' } });
  });

  it('_types is a type-only phantom (empty at runtime)', () => {
    expect(events._types).toEqual({});
  });

  it('the produced event is a valid InputEvent', () => {
    const event: InputEvent<'system.userLoggedIn', { userId: string }> = events.system.userLoggedIn(
      { userId: 'u1' },
    );
    expect(event.type).toBe('system.userLoggedIn');
  });
});
