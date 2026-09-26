import type { RagPublications } from '../rag/types';

/** Structural subset of DurableObjectStorage and its retryable transaction. */
export interface DurablePublicationTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string; startAfter?: string; limit: number }): Promise<Map<string, T>>;
}
export interface DurablePublicationStorage {
  transaction<T>(body: (tx: DurablePublicationTransaction) => Promise<T>): Promise<T>;
}

/**
 * Use only with native Durable Object storage, owned by one stable DO per scope.
 * JSON values are split into bounded parts inside the same atomic transaction,
 * so maximum-size RAG documents never occupy a single 128 KiB KV value.
 */
export const durableObjectPublications = (storage: DurablePublicationStorage): RagPublications => ({
  async transaction(scope, body) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(['rag-publications-v1', scope.namespace ?? null])),
    );
    const namespace =
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') + ':';
    return storage.transaction(async (native) => {
      let open = true;
      const check = () => {
        if (!open) throw new Error('Publication transaction is closed');
      };
      const root = (key: string) => {
        if (
          typeof key !== 'string' ||
          !key.isWellFormed() ||
          new TextEncoder().encode(key).length > 1024
        )
          throw new Error('Publication key exceeds 1024 UTF-8 bytes');
        return `${namespace}root:${key}`;
      };
      const part = (key: string, index: number) => `${namespace}part:${key}:${index}`;
      const count = async (key: string): Promise<number | undefined> => {
        check();
        const value = await native.get<unknown>(root(key));
        if (value === undefined) return undefined;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 128)
          throw new Error('Corrupt publication record parts');
        return value;
      };
      const get = async <T>(key: string): Promise<T | undefined> => {
        const length = await count(key);
        if (length === undefined) return undefined;
        const parts = await Promise.all(
          Array.from({ length }, (_, i) => native.get<unknown>(part(key, i))),
        );
        if (parts.some((value) => typeof value !== 'string' || value.length > 8192))
          throw new Error('Corrupt publication record part');
        check();
        return JSON.parse(parts.join('')) as T;
      };
      try {
        return await body({
          get,
          async put(key, value) {
            check();
            const encoded = JSON.stringify(value);
            if (encoded === undefined || encoded.length > 1024 * 1024)
              throw new Error('Publication record exceeds 1 MiB JSON limit');
            const old = (await count(key)) ?? 0;
            const size = Math.max(1, Math.ceil(encoded.length / 8192));
            check();
            await native.put(root(key), size);
            await Promise.all(
              Array.from({ length: size }, (_, i) =>
                native.put(part(key, i), encoded.slice(i * 8192, (i + 1) * 8192)),
              ),
            );
            await Promise.all(
              Array.from({ length: Math.max(0, old - size) }, (_, i) =>
                native.delete(part(key, size + i)),
              ),
            );
          },
          async delete(key) {
            const size = (await count(key)) ?? 0;
            check();
            await native.delete(root(key));
            await Promise.all(Array.from({ length: size }, (_, i) => native.delete(part(key, i))));
          },
          async list<T>({
            prefix,
            after,
            limit,
          }: {
            prefix: string;
            after?: string | undefined;
            limit: number;
          }) {
            check();
            const roots = await native.list<number>({
              prefix: root(prefix),
              ...(after === undefined ? {} : { startAfter: root(after) }),
              limit,
            });
            const output = new Map<string, T>();
            for (const storedKey of roots.keys()) {
              const key = storedKey.slice(root('').length);
              // oxlint-disable-next-line eslint/no-await-in-loop
              const value = await get<T>(key);
              if (value !== undefined) output.set(key, value);
            }
            return output;
          },
        });
      } finally {
        open = false;
      }
    });
  },
});
