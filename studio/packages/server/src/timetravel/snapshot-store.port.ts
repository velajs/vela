/**
 * `SnapshotStore` — the blob/JSON persistence seam the portable snapshot adapter
 * writes its NDJSON row dumps and manifests to. Deliberately tiny and streaming
 * (`putStream`/`getStream`) so a whole table never has to be buffered by the
 * adapter, and edge-safe (no `node:*`): the core ships an in-memory impl for
 * tests and single-instance deploys; a filesystem impl (`node:fs`) is deferred to
 * the host/CLI in M10, and a CF R2/KV impl arrives with the DO adapter (M11).
 *
 * Keys are opaque strings the adapter namespaces (`manifests/<id>.json`,
 * `snapshots/<id>/<table>.ndjson`); `list(prefix)` powers mark enumeration and
 * pruning.
 */
import { InjectionToken } from '@velajs/vela';

/** A bindable blob + JSON store for portable snapshots. */
export interface SnapshotStore {
  /** Persist a byte stream under `key`, consuming it fully. Overwrites. */
  putStream(key: string, stream: ReadableStream<Uint8Array>): Promise<void>;
  /** Read the byte stream at `key`, or `null` when absent. */
  getStream(key: string): Promise<ReadableStream<Uint8Array> | null>;
  /** Persist a JSON-serializable value under `key`. Overwrites. */
  putJson<T>(key: string, value: T): Promise<void>;
  /** Read + parse the JSON value at `key`, or `null` when absent. */
  getJson<T>(key: string): Promise<T | null>;
  /** Every key with the given prefix (unordered). */
  list(prefix: string): Promise<string[]>;
  /** Delete `key` if present (a no-op when absent). */
  delete(key: string): Promise<void>;
}

/** DI token the portable adapter resolves its {@link SnapshotStore} from. */
export const SNAPSHOT_STORE = new InjectionToken<SnapshotStore>('SNAPSHOT_STORE');

/** Collect a byte stream into a single `Uint8Array` (used by the in-memory store). */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Wrap fixed bytes as a single-chunk `ReadableStream`. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Process-local {@link SnapshotStore}. Blobs are held as `Uint8Array`, JSON is
 * deep-cloned on write so a later caller mutation can't corrupt a stored value.
 * Edge-safe (Web Streams + structured clone only). NOT durable across restarts —
 * the fs/R2 impls (M10/M11) are.
 */
export class InMemorySnapshotStore implements SnapshotStore {
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly json = new Map<string, unknown>();

  async putStream(key: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    this.blobs.set(key, await drain(stream));
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = this.blobs.get(key);
    return bytes === undefined ? null : streamOf(bytes);
  }

  async putJson<T>(key: string, value: T): Promise<void> {
    this.json.set(key, structuredClone(value));
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = this.json.get(key);
    return value === undefined ? null : (structuredClone(value) as T);
  }

  async list(prefix: string): Promise<string[]> {
    const keys = new Set<string>();
    for (const key of this.blobs.keys()) if (key.startsWith(prefix)) keys.add(key);
    for (const key of this.json.keys()) if (key.startsWith(prefix)) keys.add(key);
    return [...keys];
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
    this.json.delete(key);
  }
}
