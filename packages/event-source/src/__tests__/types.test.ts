import { describe, expect, it } from 'vitest';
import {
  defineEvents,
  payload,
  type ClientSeq,
  type EventLogEntry,
  type EventReducer,
  type EventSource,
  type InferPayload,
  type InputEvent,
  type PayloadType,
  type RowChange,
} from '../index';

// ── Compile-time assertion helpers ─────────────────────────────────────────
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// A stand-in Standard Schema validator for structural inference checks.
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

interface Counter extends Record<string, unknown> {
  total: number;
}

const events = defineEvents({
  chat: {
    messageSent: stdSchema<{ channelId: string; text: string }>(),
    typing: payload<{ userId: string }>(),
  },
  system: {
    tick: payload<number>(),
  },
});

// ── defineEvents payload inference ──────────────────────────────────────────
type Sent = ReturnType<typeof events.chat.messageSent>;
type _Sent = Expect<
  Equal<Sent, InputEvent<'chat.messageSent', { channelId: string; text: string }>>
>;

type Typing = ReturnType<typeof events.chat.typing>;
type _Typing = Expect<Equal<Typing, InputEvent<'chat.typing', { userId: string }>>>;

type Tick = ReturnType<typeof events.system.tick>;
type _Tick = Expect<Equal<Tick, InputEvent<'system.tick', number>>>;

// Factory argument + `.type` literal.
type _Arg = Expect<
  Equal<Parameters<typeof events.chat.messageSent>, [{ channelId: string; text: string }]>
>;
type _FactoryType = Expect<Equal<typeof events.chat.messageSent.type, 'chat.messageSent'>>;

// ── _types phantom map (indexed access, robust against intersection shape) ──
type Types = typeof events._types;
type _MapSent = Expect<Equal<Types['chat.messageSent'], { channelId: string; text: string }>>;
type _MapTick = Expect<Equal<Types['system.tick'], number>>;

// ── InferPayload directly ───────────────────────────────────────────────────
type _InferSchema = Expect<Equal<InferPayload<StdSchema<{ a: 1 }>>, { a: 1 }>>;
type _InferMarker = Expect<Equal<InferPayload<PayloadType<string>>, string>>;

// ── Seq + reducer + row-change surfaces ─────────────────────────────────────
type _ClientSeq = Expect<
  Equal<
    ClientSeq,
    { readonly client: number; readonly global: number; readonly rebaseGeneration: number }
  >
>;

type _Reducer = Expect<Equal<Parameters<EventReducer<Counter>>, [Counter, EventLogEntry]>>;

type Insert = Extract<RowChange, { op: 'insert' }>;
type _Insert = Expect<
  Equal<
    Insert,
    { readonly op: 'insert'; readonly key: string; readonly row: Record<string, unknown> }
  >
>;

// EventSource exposes state as a read-only view.
type _State = Expect<Equal<EventSource<Counter>['state'], Readonly<Counter>>>;

describe('type-level surface', () => {
  it('exported signatures infer as asserted (checked by tsc over this file)', () => {
    // The `_*` aliases above fail the typecheck if any assertion is false.
    const event = events.chat.messageSent({ channelId: 'c1', text: 'hi' });
    expect(event.type).toBe('chat.messageSent');
  });
});
