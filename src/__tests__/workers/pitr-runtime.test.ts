// @ts-expect-error virtual module supplied by @cloudflare/vitest-pool-workers
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { VelaDoPitrRpc } from '../../index';

/**
 * Real workerd / Miniflare coverage for the Durable Object PITR RPC on a genuine
 * SQLite-backed DO (`TestRoom` is declared `new_sqlite_classes` in
 * `wrangler.test.toml`). A DO stub is only obtainable from a Worker that binds
 * the namespace — the same intra-worker-only reachability the guard relies on.
 *
 * This asserts the miniflare-testable subset. Miniflare's local SQLite backend
 * implements `getCurrentBookmark()` but NOT the time-travel *restore* primitives
 * (`getBookmarkForTime` / `onNextSessionRestoreBookmark` throw "does not
 * implement point-in-time recovery" — real PITR history is a production-only
 * Cloudflare capability). So the reachable, cleanly-runnable coverage here is the
 * current-bookmark read end-to-end over the worker→DO RPC hop; the arm / undo /
 * by-time / typed-unavailable logic is covered against fully- and partially-
 * capable fake storages in `src/__tests__/do-pitr.test.ts`.
 */

interface PitrRoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): VelaDoPitrRpc;
}

function room(name: string): VelaDoPitrRpc {
  const ns = (env as { TEST_ROOM: PitrRoomNamespace }).TEST_ROOM;
  return ns.get(ns.idFromName(name));
}

describe('Durable Object PITR RPC under workerd (real SQLite DO)', () => {
  it('reads the current bookmark over the worker→DO RPC hop', async () => {
    const read = await room('pitr-current').pitrCurrentBookmark();
    expect(typeof read.current).toBe('string');
    expect(read.current.length).toBeGreaterThan(0);
    expect(read.forTime).toBeUndefined();
  });

  it('serves distinct DO instances by name (per-room isolation of the RPC)', async () => {
    const a = await room('pitr-room-a').pitrCurrentBookmark();
    const b = await room('pitr-room-b').pitrCurrentBookmark();
    expect(typeof a.current).toBe('string');
    expect(typeof b.current).toBe('string');
    // Re-reading the same DO yields a well-formed bookmark again (stable RPC).
    const aAgain = await room('pitr-room-a').pitrCurrentBookmark();
    expect(aAgain.current.length).toBeGreaterThan(0);
  });
});
