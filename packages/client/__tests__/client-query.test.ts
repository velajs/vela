import { describe, expect, it } from 'vitest';
import { createClientQuery, LiveClient } from '../src/index';

const clientFor = () => new LiveClient({ url: 'http://api.test' });

describe('client-query store', () => {
  it('returns the default value until set', () => {
    const client = clientFor();
    const filter = createClientQuery('todos.filter', 'all');
    expect(client.getClientQuery(filter)).toBe('all');
  });

  it('set notifies subscribers and updates the snapshot', () => {
    const client = clientFor();
    const count = createClientQuery('cart.count', 0);
    const seen: number[] = [];
    const stop = client.subscribeClientQuery(count, () => seen.push(client.getClientQuery(count)));

    client.setClientQuery(count, 1);
    client.setClientQuery(count, 2);
    expect(seen).toEqual([1, 2]);
    expect(client.getClientQuery(count)).toBe(2);

    stop();
    client.setClientQuery(count, 3);
    expect(seen).toEqual([1, 2]); // unsubscribed
  });

  it('is shared across consumers of the same ref', () => {
    const client = clientFor();
    const theme = createClientQuery<'light' | 'dark'>('ui.theme', 'light');
    const a: string[] = [];
    const b: string[] = [];
    client.subscribeClientQuery(theme, () => a.push(client.getClientQuery(theme)));
    client.subscribeClientQuery(theme, () => b.push(client.getClientQuery(theme)));

    client.setClientQuery(theme, 'dark');
    expect(a).toEqual(['dark']);
    expect(b).toEqual(['dark']);
  });

  it('returns a referentially stable snapshot between writes (no tearing)', () => {
    const client = clientFor();
    const list = createClientQuery<string[]>('draft.tags', []);
    const first = client.getClientQuery(list);
    expect(client.getClientQuery(list)).toBe(first); // same default reference
    const next = ['a'];
    client.setClientQuery(list, next);
    expect(client.getClientQuery(list)).toBe(next);
    expect(client.getClientQuery(list)).toBe(next); // stable until the next write
  });

  it('swallows a throwing subscriber without stalling the others', () => {
    const client = clientFor();
    const flag = createClientQuery('flag', false);
    const seen: boolean[] = [];
    client.subscribeClientQuery(flag, () => {
      throw new Error('boom');
    });
    client.subscribeClientQuery(flag, () => seen.push(client.getClientQuery(flag)));
    expect(() => client.setClientQuery(flag, true)).not.toThrow();
    expect(seen).toEqual([true]);
  });
});
