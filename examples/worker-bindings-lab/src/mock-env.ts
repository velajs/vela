import type { CloudflareEnv } from '@velajs/cloudflare';

export type MockKV = KVNamespace & {
  _store: Map<string, string>;
};

export type MockQueue = Queue<unknown> & {
  _messages: unknown[];
};

export interface WorkerBindingsLabEnv extends CloudflareEnv {
  CACHE: MockKV;
  DB: D1Database;
  ASSETS: R2Bucket;
  JOB_QUEUE: MockQueue;
  COUNTER_DO: DurableObjectNamespace;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  HYPERDRIVE: Hyperdrive;
  EVENT_LOG: string[];
}

function createMockKV(): MockKV {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    getWithMetadata: async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: null,
      cacheStatus: null,
    }),
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({
      keys: [...store.keys()].map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
      cacheStatus: null,
    }),
    _store: store,
  } as unknown as MockKV;
}

function createMockD1(): D1Database {
  const users = [
    { id: 'u1', name: 'Ada Harbor' },
    { id: 'u2', name: 'Lin Dock' },
  ];

  const statement = {
    bind: (...values: unknown[]) => ({
      first: async () => users.find((row) => row.id === values[0]) ?? null,
      all: async () => ({ results: users, success: true, meta: {} }),
      run: async () => ({ success: true, meta: {} }),
    }),
    first: async () => users[0],
    all: async () => ({ results: users, success: true, meta: {} }),
    run: async () => ({ success: true, meta: {} }),
  };

  return {
    prepare: () => statement,
    batch: async (statements: D1PreparedStatement[]) =>
      statements.map(() => ({ results: [], success: true, meta: {} })),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

function createMockR2(): R2Bucket {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return {
        key,
        size: value.length,
        text: async () => value,
        json: async () => JSON.parse(value),
        arrayBuffer: async () => new TextEncoder().encode(value).buffer,
      };
    },
    head: async (key: string) => {
      const value = store.get(key);
      return value === undefined ? null : { key, size: value.length };
    },
    put: async (key: string, value: string | ArrayBuffer | ArrayBufferView) => {
      store.set(key, typeof value === 'string' ? value : String(value));
      return { key };
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        store.delete(key);
      }
    },
    list: async () => ({
      objects: [...store.keys()].map((key) => ({ key })),
      delimitedPrefixes: [],
      truncated: false,
    }),
  } as unknown as R2Bucket;
}

function createMockQueue(): MockQueue {
  const messages: unknown[] = [];
  return {
    send: async (message: unknown) => {
      messages.push(message);
    },
    sendBatch: async (batch: Iterable<{ body: unknown }>) => {
      for (const message of batch) {
        messages.push(message.body);
      }
    },
    _messages: messages,
  } as unknown as MockQueue;
}

function createMockDurableObjectNamespace(): DurableObjectNamespace {
  const stub = {
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return Response.json({
        durableObject: true,
        name: url.pathname.split('/').pop() ?? 'unknown',
      });
    },
  };

  return {
    idFromName: (name: string) => ({ name, toString: () => `id:${name}` }),
    idFromString: (id: string) => ({ id, toString: () => id }),
    newUniqueId: () => ({ toString: () => 'id:unique' }),
    get: () => stub,
    jurisdiction: () => ({ get: () => stub }),
  } as unknown as DurableObjectNamespace;
}

function createMockAI(): Ai {
  return {
    run: async (model: string, input: unknown) => ({
      model,
      input,
      response: 'lab-ai-response',
    }),
  } as unknown as Ai;
}

function createMockVectorize(): VectorizeIndex {
  return {
    query: async () => ({
      matches: [
        {
          id: 'doc-1',
          score: 0.98,
          metadata: { title: 'Harbor safety guide' },
        },
      ],
      count: 1,
    }),
  } as unknown as VectorizeIndex;
}

function createMockHyperdrive(): Hyperdrive {
  return {
    connectionString: 'postgres://lab:secret@db.example.test:5432/worker_lab',
    host: 'db.example.test',
    port: 5432,
    user: 'lab',
    password: 'secret',
    database: 'worker_lab',
  } as unknown as Hyperdrive;
}

export function createMockWorkerEnv(): WorkerBindingsLabEnv {
  return {
    CACHE: createMockKV(),
    DB: createMockD1(),
    ASSETS: createMockR2(),
    JOB_QUEUE: createMockQueue(),
    COUNTER_DO: createMockDurableObjectNamespace(),
    AI: createMockAI(),
    VECTORIZE: createMockVectorize(),
    HYPERDRIVE: createMockHyperdrive(),
    EVENT_LOG: [],
  };
}

export function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}
