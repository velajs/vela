import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Injectable } from '../../container/decorators';
import { Scope } from '../../constants';
import { Module } from '../../module';
import { VelaFactory } from '../../factory';
import { createExecutionScope } from '../../entrypoint/execution-scope';
import {
  EventEmitter,
  EventEmitterModule,
  EventDispatcher,
  defineEvent,
  OnEvent,
} from '../../event-emitter';

describe('Workers event delivery', () => {
  it('preserves private listener state and deferred scope disposal in workerd', async () => {
    let validations = 0;
    const event = defineEvent(
      'worker.event',
      z.string().transform(async (value) => {
        validations++;
        await Promise.resolve();
        return Number(value);
      }),
    );
    const seen: number[] = [];
    let disposed = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Listener {
      readonly #offset = 1;
      @OnEvent(event)
      receive(value: number) {
        seen.push(value + this.#offset);
      }
      dispose() {
        disposed++;
      }
    }
    @Module({ imports: [EventEmitterModule], providers: [Listener] })
    class App {}
    const app = await VelaFactory.create(App);
    const scope = createExecutionScope(app.getContainer());
    app.get(EventDispatcher).inScope(scope.container).defer(event, '41');
    expect(seen).toEqual([]);
    await scope.finish();
    expect(seen).toEqual([42]);
    expect(validations).toBe(1);
    expect(disposed).toBe(1);
    await app.dispose();
  });

  it('consumes once listeners across concurrent failure and settles wildcard delivery', async () => {
    const emitter = new EventEmitter();
    let calls = 0;
    let wildcard = 0;
    emitter.once('test', async () => {
      calls++;
      await Promise.resolve();
      throw Error('expected');
    });
    emitter.on('**', () => {
      wildcard++;
    });
    await Promise.allSettled([emitter.emit('test'), emitter.emit('test')]);
    expect(calls).toBe(1);
    expect(wildcard).toBe(2);
  });
});
