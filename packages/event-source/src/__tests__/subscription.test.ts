import { describe, expect, it, vi } from 'vitest';
import { SubscriptionManager, type EventLogEntry } from '../index';

const entry = (type: string): EventLogEntry => ({ seq: 0, type, payload: null, timestamp: 0 });

describe('SubscriptionManager', () => {
  it('notifies state-change subscribers', () => {
    const subs = new SubscriptionManager();
    const seen: unknown[] = [];
    subs.onStateChange((state) => seen.push(state));
    subs.notifyState({ users: 1 });
    expect(seen).toEqual([{ users: 1 }]);
  });

  it('routes events only to matching type subscribers', () => {
    const subs = new SubscriptionManager();
    const created = vi.fn();
    const deleted = vi.fn();
    subs.onEvent('user-created', created);
    subs.onEvent('user-deleted', deleted);
    subs.notifyEvent(entry('user-created'));
    expect(created).toHaveBeenCalledOnce();
    expect(deleted).not.toHaveBeenCalled();
  });

  it('disposers remove subscriptions and size reflects the count', () => {
    const subs = new SubscriptionManager();
    const dispose = subs.onStateChange(() => {});
    subs.onEvent('x', () => {});
    expect(subs.size).toBe(2);
    dispose();
    expect(subs.size).toBe(1);
    subs.clear();
    expect(subs.size).toBe(0);
  });

  it('a throwing subscriber does not stop the others', () => {
    const subs = new SubscriptionManager();
    const good = vi.fn();
    subs.onStateChange(() => {
      throw new Error('boom');
    });
    subs.onStateChange(good);
    expect(() => subs.notifyState({})).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });
});
