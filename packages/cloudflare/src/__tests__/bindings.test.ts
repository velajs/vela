import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Binding } from '@velajs/vela/module-kit';
import { d1, durableObject, kv, queue, r2, rateLimit } from '../index';

const fn = async () => null;

const natives = {
  CACHE: { get: fn, put: fn, delete: fn, list: fn, getWithMetadata: fn },
  BUCKET: { get: fn, put: fn, head: fn, delete: fn, list: fn, createMultipartUpload: fn },
  DB: { prepare: fn, batch: fn, exec: fn },
  JOBS: { send: fn, sendBatch: fn },
  ROOMS: { idFromName: fn, get: fn },
  LIMITER: { limit: fn },
};

describe('Cloudflare binding factories', () => {
  it('type each binding with its native Workers type', () => {
    expectTypeOf(kv({ binding: 'CACHE' })).toEqualTypeOf<Binding<KVNamespace>>();
    expectTypeOf(r2({ binding: 'BUCKET' })).toEqualTypeOf<Binding<R2Bucket>>();
    expectTypeOf(d1({ binding: 'DB' })).toEqualTypeOf<Binding<D1Database>>();
    expectTypeOf(queue({ binding: 'JOBS' })).toEqualTypeOf<Binding<Queue>>();
    expectTypeOf(durableObject({ binding: 'ROOMS' })).toEqualTypeOf<
      Binding<DurableObjectNamespace>
    >();
    expectTypeOf(rateLimit({ binding: 'LIMITER' })).toEqualTypeOf<Binding<RateLimit>>();
  });

  it('resolve each kind from the environment it is called with', () => {
    expect(kv({ binding: 'CACHE' })(natives)).toBe(natives.CACHE);
    expect(r2({ binding: 'BUCKET' })(natives)).toBe(natives.BUCKET);
    expect(d1({ binding: 'DB' })(natives)).toBe(natives.DB);
    expect(queue({ binding: 'JOBS' })(natives)).toBe(natives.JOBS);
    expect(durableObject({ binding: 'ROOMS' })(natives)).toBe(natives.ROOMS);
    expect(rateLimit({ binding: 'LIMITER' })(natives)).toBe(natives.LIMITER);
  });

  it('name the Wrangler key that declares a missing binding', () => {
    expect(() => kv({ binding: 'CACHE' })({})).toThrow('under kv_namespaces');
    expect(() => r2({ binding: 'BUCKET' })({})).toThrow('under r2_buckets');
    expect(() => d1({ binding: 'DB' })({})).toThrow('under d1_databases');
    expect(() => queue({ binding: 'JOBS' })({})).toThrow('under queues.producers');
    expect(() => durableObject({ binding: 'ROOMS' })({})).toThrow('under durable_objects.bindings');
    expect(() => rateLimit({ binding: 'LIMITER' })({})).toThrow('under ratelimits');
  });

  it('reject a binding of another kind', () => {
    expect(() => kv({ binding: 'DB' })(natives)).toThrow(
      'ENV.DB is not a binding of type KV namespace',
    );
    expect(() => r2({ binding: 'CACHE' })(natives)).toThrow('is not a binding of type R2 bucket');
    expect(() => rateLimit({ binding: 'JOBS' })(natives)).toThrow(
      'is not a binding of type rate limiter',
    );
  });
});
