import type { RagEmbedder, RagTextStore } from '../rag';

/**
 * A tiny deterministic embedder for tests: a bag-of-keywords vector over a fixed
 * vocabulary. Two texts sharing keywords have a high cosine similarity, so
 * ranking assertions are meaningful without a real model.
 */
export const VOCAB = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'] as const;

export const keywordEmbedder = (): RagEmbedder => {
  return (text: string): number[] => {
    const lower = text.toLowerCase();

    return VOCAB.map((word) => (lower.includes(word) ? 1 : 0));
  };
};

export interface CountingEmbedder {
  embed: RagEmbedder;
  /** Number of times the embedder has been invoked so far. */
  callCount: () => number;
  /** The texts passed to the embedder, in order. */
  texts: string[];
}

/** Wrap an embedder so a test can assert how many times (and on what) it ran. */
export const countingEmbedder = (base: RagEmbedder = keywordEmbedder()): CountingEmbedder => {
  let calls = 0;
  const texts: string[] = [];

  const embed: RagEmbedder = (text: string) => {
    calls += 1;
    texts.push(text);

    return base(text);
  };

  return { embed, callCount: () => calls, texts };
};

const TEXT_SHARED = ' shared';

/** An in-memory {@link RagTextStore} for exercising text-store mode. */
export const memoryTextStore = (): RagTextStore => {
  const partitions = new Map<string, Map<string, string>>();

  const bucket = (namespace: string | undefined): Map<string, string> => {
    const key = namespace ?? TEXT_SHARED;
    let existing = partitions.get(key);

    if (existing === undefined) {
      existing = new Map();
      partitions.set(key, existing);
    }

    return existing;
  };

  return {
    put: async (chunks, { namespace }) => {
      const store = bucket(namespace);

      for (const chunk of chunks) {
        store.set(chunk.id, chunk.text);
      }
    },
    getMany: async (ids, { namespace }) => {
      const store = partitions.get(namespace ?? TEXT_SHARED);

      return ids.map((id) => store?.get(id));
    },
    remove: async (ids, { namespace }) => {
      const store = partitions.get(namespace ?? TEXT_SHARED);

      if (store !== undefined) {
        for (const id of ids) {
          store.delete(id);
        }
      }
    },
  };
};

/** A splitter that cuts on `|` — lets a test place known keywords in known chunks. */
export const pipeSplitter = (text: string): string[] => text.split('|').map((part) => part.trim());
