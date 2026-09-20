import type { ClientQueryRef, Unsubscribe } from './types';

/** One typed reference owns a separate cell per client; keys are diagnostic labels. */
export function createClientQuery<T>(key: string, defaultValue: T): ClientQueryRef<T> {
  const cells = new WeakMap<object, { value: T; listeners: Set<() => void> }>();
  const cell = (owner: object) => {
    let value = cells.get(owner);
    if (!value) {
      value = { value: defaultValue, listeners: new Set() };
      cells.set(owner, value);
    }
    return value;
  };
  return Object.freeze({
    key,
    defaultValue,
    read: (owner: object): T => cell(owner).value,
    write(owner: object, value: T): void {
      const target = cell(owner);
      target.value = value;
      for (const listener of [...target.listeners]) {
        try {
          listener();
        } catch {
          /* One observer cannot block others. */
        }
      }
    },
    observe(owner: object, listener: () => void): Unsubscribe {
      const target = cell(owner);
      target.listeners.add(listener);
      return () => {
        target.listeners.delete(listener);
      };
    },
  });
}

export class ClientQueryStore {
  get<T>(ref: ClientQueryRef<T>): T {
    return ref.read(this);
  }
  set<T>(ref: ClientQueryRef<T>, value: T): void {
    ref.write(this, value);
  }
  subscribe<T>(ref: ClientQueryRef<T>, listener: () => void): Unsubscribe {
    return ref.observe(this, listener);
  }
}
