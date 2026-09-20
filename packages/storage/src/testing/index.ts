// @velajs/storage/testing — assertion helpers for tests.
//
// Vela has no separate storage fake: the in-package **memory driver IS the
// fake**. Build a test disk in one obvious line and assert against it —
// no bootstrap, no subclass:
//
//   import { createStorage } from '@velajs/storage';
//   import { memoryDriver } from '@velajs/storage/drivers/memory';
//   import { assertExists, assertCount } from '@velajs/storage/testing';
//
//   const storage = createStorage({ driver: memoryDriver() });
//   await storage.upload('avatar.png', bytes);
//   await assertExists(storage, 'avatar.png');
//   await assertCount(storage, 'avatars/', 1);
//
// For DI/integration tests, register the same driver on the module instead —
// `StorageModule.forRoot({ driver: memoryDriver() })` — then inject the
// `StorageService` and pass it to these helpers. Both a `Storage` facade and a
// `StorageService` satisfy the {@link StorageTarget} surface below.
//
// The helpers are thin and framework-free: they throw a plain `Error` with a
// diagnostic message on failure (no vitest/`expect` dependency), and drive the
// public `exists`/`list` API so prefix scoping and drivers stay honest.

import type { ListOptions, ListResult, OperationOptions } from '../storage.types';

/**
 * The read surface the assertions need. Satisfied by `StorageService`, the
 * `Storage` facade, and a bare `StorageDriver` — anything memory-backed works.
 */
export interface StorageTarget {
  exists(key: string, opts?: OperationOptions): Promise<boolean>;
  list(opts?: ListOptions): Promise<ListResult>;
}

/** Assert an object exists at `key`; throws a diagnostic `Error` otherwise. */
export async function assertExists(storage: StorageTarget, key: string): Promise<void> {
  if (!(await storage.exists(key))) {
    const keys = await collectKeys(storage);
    throw new Error(
      `assertExists: expected an object at "${key}" to exist, but it is missing. ` +
        `Stored: ${keys.length ? keys.join(', ') : '(none)'}`,
    );
  }
}

/** Assert nothing is stored at `key`; throws a diagnostic `Error` otherwise. */
export async function assertMissing(storage: StorageTarget, key: string): Promise<void> {
  if (await storage.exists(key)) {
    throw new Error(`assertMissing: expected no object at "${key}", but one exists`);
  }
}

/** Assert the disk holds exactly `expected` objects. */
export function assertCount(storage: StorageTarget, expected: number): Promise<void>;
/** Assert exactly `expected` objects exist under `prefix`. */
export function assertCount(
  storage: StorageTarget,
  prefix: string,
  expected: number,
): Promise<void>;
export async function assertCount(
  storage: StorageTarget,
  prefixOrExpected: string | number,
  maybeExpected?: number,
): Promise<void> {
  const prefix = typeof prefixOrExpected === 'string' ? prefixOrExpected : undefined;
  const expected = typeof prefixOrExpected === 'number' ? prefixOrExpected : maybeExpected!;
  const keys = await collectKeys(storage, prefix);
  if (keys.length !== expected) {
    const scope = prefix ? ` under prefix "${prefix}"` : '';
    const found = keys.length ? `: ${keys.join(', ')}` : '';
    throw new Error(
      `assertCount: expected ${expected} object(s)${scope}, but found ${keys.length}${found}`,
    );
  }
}

/** Walk every listing page (following the cursor) and collect the object keys. */
async function collectKeys(storage: StorageTarget, prefix?: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.list({ prefix, cursor });
    for (const item of page.items) keys.push(item.key);
    cursor = page.cursor;
  } while (cursor);
  return keys;
}
