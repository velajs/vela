import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from '../index';

type Events = { hello: { name: string }; tick: number };

describe('EventEmitter', () => {
  it('delivers typed payloads to named handlers', () => {
    const emitter = new EventEmitter<Events>();
    const seen: string[] = [];
    emitter.on('hello', (payload) => seen.push(payload.name));
    expect(emitter.emit('hello', { name: 'ada' })).toBe(true);
    expect(seen).toEqual(['ada']);
  });

  it('emit returns false when nothing is listening', () => {
    const emitter = new EventEmitter<Events>();
    expect(emitter.emit('tick', 1)).toBe(false);
  });

  it('on returns a disposer and off removes handlers', () => {
    const emitter = new EventEmitter<Events>();
    const handler = vi.fn();
    const dispose = emitter.on('tick', handler);
    emitter.emit('tick', 1);
    dispose();
    emitter.emit('tick', 2);
    emitter.on('tick', handler);
    emitter.off('tick', handler);
    emitter.emit('tick', 3);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('once fires a single time', () => {
    const emitter = new EventEmitter<Events>();
    const handler = vi.fn();
    emitter.once('tick', handler);
    emitter.emit('tick', 1);
    emitter.emit('tick', 2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('onAny observes every event', () => {
    const emitter = new EventEmitter<Events>();
    const seen: (keyof Events)[] = [];
    const dispose = emitter.onAny((event) => seen.push(event));
    emitter.emit('hello', { name: 'x' });
    emitter.emit('tick', 5);
    dispose();
    emitter.emit('tick', 6);
    expect(seen).toEqual(['hello', 'tick']);
  });

  it('a throwing handler does not break the dispatch loop', () => {
    const emitter = new EventEmitter<Events>();
    const good = vi.fn();
    emitter.on('tick', () => {
      throw new Error('boom');
    });
    emitter.on('tick', good);
    expect(() => emitter.emit('tick', 1)).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  it('reports listener presence and counts, and clears', () => {
    const emitter = new EventEmitter<Events>();
    emitter.on('tick', () => {});
    emitter.on('tick', () => {});
    expect(emitter.hasListeners('tick')).toBe(true);
    expect(emitter.listenerCount('tick')).toBe(2);
    emitter.clear();
    expect(emitter.hasListeners('tick')).toBe(false);
    expect(emitter.listenerCount('tick')).toBe(0);
  });
});
