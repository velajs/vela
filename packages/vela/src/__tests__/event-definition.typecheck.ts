import { z } from 'zod';
import { defineEvent, defineEventVocabulary } from '../event-emitter/event-definition';
import { OnEvent } from '../event-emitter/event-emitter.decorators';
import type { EventPayload } from '../event-emitter/event-definition';
import type { EventDispatcher, ScopedEventDispatcher } from '../event-emitter/event-dispatcher';

const events = defineEventVocabulary({
  'account.created': z.object({ id: z.string().transform(Number) }),
  tick: z.number(),
});
const created = events['account.created'];
const individual = defineEvent(
  'individual',
  z.string().transform((s) => s.length),
);

class Listener {
  @OnEvent(created)
  created(payload: EventPayload<typeof created>) {
    return payload.id.toFixed();
  }

  // @ts-expect-error Listener consumes transformed output, not wire input.
  @OnEvent(created)
  wrong(payload: { id: string }) {
    return payload.id;
  }
}
void Listener;

function types(dispatcher: EventDispatcher, scope: ScopedEventDispatcher) {
  void dispatcher.emit(created, { id: '42' });
  void scope.emit(individual, 'forty-two');
  scope.defer(events.tick, 1);
  void scope.emitUnknown(created, { any: 'external input' });
  // @ts-expect-error Input retains the wire string type.
  void dispatcher.emit(created, { id: 42 });
  // @ts-expect-error Scalar schema input is string.
  void scope.emit(individual, 42);
  // @ts-expect-error No undeclared vocabulary entry.
  void events.missing;
  // @ts-expect-error Deferred input is checked too.
  scope.defer(events.tick, '1');
}
void types;

function rejectStringSubscriptions(): void {
  // @ts-expect-error Decorated subscriptions require validated event definitions.
  OnEvent('obsolete');
}
void rejectStringSubscriptions;
