import type { ExecutionContext } from 'hono';
import type { VelaEnv } from '@velajs/vela';

export type MockKV = KVNamespace & {
  _store: Map<string, string>;
};

export type MockQueue = Queue<unknown> & {
  _messages: unknown[];
};

/** The lab's environment, with handles tests use to inspect the in-memory KV and queue. */
export interface MockWorkerEnv extends VelaEnv {
  CACHE: MockKV;
  JOB_QUEUE: MockQueue;
  REPORT_QUEUE: MockQueue;
  SIGNUP_WORKFLOW: MockWorkflow;
}

export type MockWorkflow = VelaEnv['SIGNUP_WORKFLOW'] & {
  _created: { id: string; params: unknown }[];
};

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

/** The Counter Durable Object's RPC stub: one hit counter per name, in memory. */
function createMockDurableObjectNamespace(): MockWorkerEnv['COUNTER_DO'] {
  const hits = new Map<string, number>();
  const stub = (name: string) => ({
    status: async () => {
      const count = (hits.get(name) ?? 0) + 1;
      hits.set(name, count);
      return { durableObject: true as const, name, hits: count };
    },
  });

  return {
    idFromName: (name: string) => ({ name, toString: () => `id:${name}` }),
    getByName: (name: string) => stub(name),
  } as unknown as MockWorkerEnv['COUNTER_DO'];
}

/** The Signup Workflow binding: records the instances it creates. */
function createMockWorkflow(): MockWorkflow {
  const created: { id: string; params: unknown }[] = [];
  return {
    create: async (options?: { id?: string; params?: unknown }) => {
      const id = options?.id ?? `signup-${created.length + 1}`;
      created.push({ id, params: options?.params });
      return { id };
    },
    get: async (id: string) => ({ id }),
    _created: created,
  } as unknown as MockWorkflow;
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

export function createMockWorkerEnv(): MockWorkerEnv {
  return {
    CACHE: createMockKV(),
    DB: createMockD1(),
    ASSETS: createMockR2(),
    JOB_QUEUE: createMockQueue(),
    REPORT_QUEUE: createMockQueue(),
    COUNTER_DO: createMockDurableObjectNamespace(),
    SIGNUP_WORKFLOW: createMockWorkflow(),
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
  };
}
