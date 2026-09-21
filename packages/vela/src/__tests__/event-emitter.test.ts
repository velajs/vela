import { describe, it, expect, beforeEach } from 'vitest';
import { VelaFactory, Controller, Get, Module, Injectable, MetadataRegistry } from '../index.js';
import {
  EventEmitterModule,
  EventEmitter,
  EventEmitterSubscriber,
  OnEvent,
} from '../event-emitter/index.js';

beforeEach(() => {
  MetadataRegistry.clear();
  // Re-register EventEmitterModule metadata after clear — the @Module() decorator
  // runs once at import time, but MetadataRegistry.clear() wipes it.
  MetadataRegistry.setModuleOptions(EventEmitterModule, {
    providers: [EventEmitter, EventEmitterSubscriber],
    exports: [EventEmitter],
  });
});

describe('EventEmitter', () => {
  describe('standalone EventEmitter', () => {
    it('should emit and receive events', async () => {
      const emitter = new EventEmitter();
      const received: unknown[] = [];
      emitter.on('test', (...args) => {
        received.push(...args);
      });
      await emitter.emit('test', 'hello', 42);
      expect(received).toEqual(['hello', 42]);
    });

    it('should handle async handlers', async () => {
      const emitter = new EventEmitter();
      const order: number[] = [];
      emitter.on('test', async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      });
      emitter.on('test', async () => {
        order.push(2);
      });
      await emitter.emit('test');
      expect(order).toContain(1);
      expect(order).toContain(2);
    });

    it('should remove handler with off', async () => {
      const emitter = new EventEmitter();
      let count = 0;
      const handler = () => {
        count++;
      };
      emitter.on('test', handler);
      await emitter.emit('test');
      expect(count).toBe(1);
      emitter.off('test', handler);
      await emitter.emit('test');
      expect(count).toBe(1);
    });

    it('should fire once handler only once', async () => {
      const emitter = new EventEmitter();
      let count = 0;
      emitter.once('test', () => {
        count++;
      });
      await emitter.emit('test');
      await emitter.emit('test');
      expect(count).toBe(1);
    });

    it('should match single-level wildcard *', async () => {
      const emitter = new EventEmitter();
      const received: string[] = [];
      emitter.on('user.*', (...args) => {
        received.push(args[0] as string);
      });
      await emitter.emit('user.created', 'created');
      await emitter.emit('user.deleted', 'deleted');
      await emitter.emit('user.profile.updated', 'nested'); // Should NOT match
      expect(received).toEqual(['created', 'deleted']);
    });

    it('should match deep wildcard **', async () => {
      const emitter = new EventEmitter();
      const received: string[] = [];
      emitter.on('user.**', (...args) => {
        received.push(args[0] as string);
      });
      await emitter.emit('user.created', 'created');
      await emitter.emit('user.profile.updated', 'nested');
      expect(received).toEqual(['created', 'nested']);
    });

    it('should report correct listenerCount', () => {
      const emitter = new EventEmitter();
      emitter.on('test', () => {});
      emitter.on('test', () => {});
      emitter.on('other', () => {});
      expect(emitter.listenerCount('test')).toBe(2);
      expect(emitter.listenerCount('other')).toBe(1);
      expect(emitter.listenerCount('none')).toBe(0);
    });

    it('should remove all listeners', () => {
      const emitter = new EventEmitter();
      emitter.on('a', () => {});
      emitter.on('b', () => {});
      emitter.removeAllListeners();
      expect(emitter.listenerCount('a')).toBe(0);
      expect(emitter.listenerCount('b')).toBe(0);
    });
  });

  describe('@OnEvent auto-subscription', () => {
    it('should auto-subscribe @OnEvent methods after bootstrap', async () => {
      const received: string[] = [];

      @Injectable()
      class UserListener {
        @OnEvent('user.created')
        onUserCreated(name: string) {
          received.push(name);
        }
      }

      @Module({
        imports: [EventEmitterModule],
        providers: [UserListener],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const emitter = app.get(EventEmitter);

      await emitter.emit('user.created', 'Alice');
      expect(received).toEqual(['Alice']);
    });

    it('should support multiple @OnEvent on same class', async () => {
      const received: string[] = [];

      @Injectable()
      class MultiListener {
        @OnEvent('order.created')
        onOrderCreated() {
          received.push('order.created');
        }

        @OnEvent('order.shipped')
        onOrderShipped() {
          received.push('order.shipped');
        }
      }

      @Module({
        imports: [EventEmitterModule],
        providers: [MultiListener],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const emitter = app.get(EventEmitter);

      await emitter.emit('order.created');
      await emitter.emit('order.shipped');
      expect(received).toEqual(['order.created', 'order.shipped']);
    });

    it('should inject EventEmitter into controllers', async () => {
      @Controller('/events')
      class EventController {
        constructor(private emitter: EventEmitter) {}

        @Get('/fire')
        async fire() {
          await this.emitter.emit('test.event', 'data');
          return { fired: true };
        }
      }

      @Module({
        imports: [EventEmitterModule],
        controllers: [EventController],
      })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const res = await app.getHonoApp().request('/events/fire');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ fired: true });
    });
  });
});

describe('event delivery lifetime', () => {
  it.each(['test', '**'])(
    'consumes %s once listeners before concurrent or throwing calls',
    async (pattern) => {
      const emitter = new EventEmitter();
      let calls = 0;
      emitter.once(pattern, async () => {
        calls++;
        await Promise.resolve();
        throw new Error('listener failed');
      });
      await Promise.allSettled([emitter.emit('test'), emitter.emit('test')]);
      await emitter.emit('test');
      expect(calls).toBe(1);
      expect(emitter.listenerCount('test')).toBe(0);
    },
  );

  it('does not invoke a once listener twice through a recursive sibling snapshot', async () => {
    const emitter = new EventEmitter();
    let recursed = false;
    let calls = 0;
    emitter.on('test', async () => {
      if (!recursed) {
        recursed = true;
        await emitter.emit('test');
      }
    });
    emitter.once('test', () => {
      calls++;
    });
    await emitter.emit('test');
    expect(calls).toBe(1);
  });

  it('keeps off identity and permits a once callback to register its next delivery', async () => {
    const emitter = new EventEmitter();
    let calls = 0;
    const callback = () => {
      calls++;
      emitter.once('test', callback);
    };
    emitter.once('test', callback);
    await emitter.emit('test');
    expect(calls).toBe(1);
    await emitter.emit('test');
    expect(calls).toBe(2);
    emitter.off('test', callback);
    await emitter.emit('test');
    expect(calls).toBe(2);
  });
});

describe('event settlement policy', () => {
  it('preserves legacy rejection and skips later wildcard groups', async () => {
    const emitter = new EventEmitter();
    let wildcard = false;
    emitter.on('test', () => {
      throw Error('exact');
    });
    emitter.on('**', () => {
      wildcard = true;
    });
    await expect(emitter.emit('test')).rejects.toThrow('exact');
    expect(wildcard).toBe(false);
  });

  it('complete delivery attempts all groups and waits for slow failures', async () => {
    const emitter = new EventEmitter();
    const exact = Error('exact');
    const wildcard = Error('wildcard');
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let settled = false;
    let received = false;
    emitter.on('test', () => {
      throw exact;
    });
    emitter.on('**', async () => {
      await barrier;
      throw wildcard;
    });
    emitter.on('**', () => {
      received = true;
    });
    const dispatch = emitter.emitWithOptions('test', { settlement: 'complete' });
    const result = dispatch.catch((error: unknown) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    expect(received).toBe(true);
    expect(settled).toBe(false);
    finish();
    expect(await result).toMatchObject({ errors: [exact, wildcard] });
  });

  it('complete delivery snapshots subscriptions and preserves a single thrown value', async () => {
    const emitter = new EventEmitter();
    const reason = { code: 'failed' };
    let lateCalls = 0;
    emitter.on('test', () => {
      emitter.on('**', () => {
        lateCalls++;
      });
      throw reason;
    });
    await expect(emitter.emitWithOptions('test', { settlement: 'complete' })).rejects.toBe(reason);
    expect(lateCalls).toBe(0);
  });
});
