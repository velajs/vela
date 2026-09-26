import type { RagPublications } from './types';

/** Serializable reference store for tests/local use. Not durable across restarts. */
export const memoryPublications = (): RagPublications => {
  let data = new Map<string, unknown>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    transaction(scope, body) {
      const prefix = JSON.stringify([scope.namespace ?? null]) + ':';
      const run = tail.then(async () => {
        const next = new Map(data);
        let open = true;
        const check = () => {
          if (!open) throw new Error('Publication transaction is closed');
        };
        try {
          const result = await body({
            async get<T>(key: string) {
              check();
              return structuredClone(next.get(prefix + key)) as T | undefined;
            },
            async put(key, value) {
              check();
              next.set(prefix + key, structuredClone(value));
            },
            async delete(key) {
              check();
              next.delete(prefix + key);
            },
            async list<T>({
              prefix: keyPrefix,
              after,
              limit,
            }: {
              prefix: string;
              after?: string | undefined;
              limit: number;
            }) {
              check();
              const keys = [...next.keys()]
                .filter((key) => key.startsWith(prefix + keyPrefix))
                .map((key) => key.slice(prefix.length))
                .toSorted()
                .filter((key) => after === undefined || key > after)
                .slice(0, limit);
              return new Map(
                keys.map((key) => [key, structuredClone(next.get(prefix + key)) as T]),
              );
            },
          });
          data = next;
          return result;
        } finally {
          open = false;
        }
      });
      tail = run.catch(() => {});
      return run;
    },
  };
};
