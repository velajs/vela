import { describe, expect, it } from 'vitest';
import { defineLiveQuery } from '../query';

const args = { parse: (value: unknown) => value };
const result = { parse: (value: unknown) => value };

describe('defineLiveQuery', () => {
  it('returns the definition, carrying the wire name clients subscribe with', () => {
    const definition = { name: 'todos.list', args, result };
    expect(defineLiveQuery(definition)).toBe(definition);
    expect(defineLiveQuery(definition).name).toBe('todos.list');
  });

  it('rejects a name a subscribe frame cannot carry', () => {
    expect(() => defineLiveQuery({ name: '', args, result })).toThrow(/live query name/);
    expect(() => defineLiveQuery({ name: 'q'.repeat(257), args, result })).toThrow(
      /live query name/,
    );
    expect(defineLiveQuery({ name: 'q'.repeat(256), args, result }).name).toHaveLength(256);
  });
});
