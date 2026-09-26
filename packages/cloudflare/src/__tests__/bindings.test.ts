import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Binding } from '@velajs/vela/module-kit';
import {
  d1,
  durableObject,
  flagship,
  kv,
  queue,
  r2,
  rateLimit,
  secretsStoreSecret,
} from '../index';

const fn = async () => null;

const natives = {
  CACHE: { get: fn, put: fn, delete: fn, list: fn, getWithMetadata: fn },
  BUCKET: { get: fn, put: fn, head: fn, delete: fn, list: fn, createMultipartUpload: fn },
  DB: { prepare: fn, batch: fn, exec: fn },
  JOBS: { send: fn, sendBatch: fn },
  ROOMS: { idFromName: fn, get: fn },
  LIMITER: { limit: fn },
  FLAGS: {
    get: fn,
    getBooleanValue: fn,
    getStringValue: fn,
    getNumberValue: fn,
    getObjectValue: fn,
    getBooleanDetails: fn,
    getStringDetails: fn,
    getNumberDetails: fn,
    getObjectDetails: fn,
  },
  API_KEY: { get: fn },
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
    expectTypeOf(flagship({ binding: 'FLAGS' })).toEqualTypeOf<Binding<Flagship>>();
    expectTypeOf(secretsStoreSecret({ binding: 'API_KEY' })).toEqualTypeOf<
      Binding<SecretsStoreSecret>
    >();
  });

  it('resolve each kind from the environment it is called with', () => {
    expect(kv({ binding: 'CACHE' })(natives)).toBe(natives.CACHE);
    expect(r2({ binding: 'BUCKET' })(natives)).toBe(natives.BUCKET);
    expect(d1({ binding: 'DB' })(natives)).toBe(natives.DB);
    expect(queue({ binding: 'JOBS' })(natives)).toBe(natives.JOBS);
    expect(durableObject({ binding: 'ROOMS' })(natives)).toBe(natives.ROOMS);
    expect(rateLimit({ binding: 'LIMITER' })(natives)).toBe(natives.LIMITER);
    expect(flagship({ binding: 'FLAGS' })(natives)).toBe(natives.FLAGS);
    expect(secretsStoreSecret({ binding: 'API_KEY' })(natives)).toBe(natives.API_KEY);
  });

  it('name the Wrangler key that declares a missing binding', () => {
    expect(() => kv({ binding: 'CACHE' })({})).toThrow('under kv_namespaces');
    expect(() => r2({ binding: 'BUCKET' })({})).toThrow('under r2_buckets');
    expect(() => d1({ binding: 'DB' })({})).toThrow('under d1_databases');
    expect(() => queue({ binding: 'JOBS' })({})).toThrow('under queues.producers');
    expect(() => durableObject({ binding: 'ROOMS' })({})).toThrow('under durable_objects.bindings');
    expect(() => rateLimit({ binding: 'LIMITER' })({})).toThrow('under ratelimits');
    expect(() => flagship({ binding: 'FLAGS' })({})).toThrow('under flagship');
    expect(() => secretsStoreSecret({ binding: 'API_KEY' })({})).toThrow(
      'under secrets_store_secrets',
    );
  });

  it('resolves native handles separately for each environment without reading values', () => {
    const flags = flagship({ binding: 'FLAGS' });
    const secret = secretsStoreSecret({ binding: 'API_KEY' });
    const other = {
      FLAGS: { ...natives.FLAGS },
      API_KEY: {
        get: () => {
          throw new Error('must not read');
        },
      },
    };
    expect(flags(other)).toBe(other.FLAGS);
    expect(flags(natives)).toBe(natives.FLAGS);
    expect(secret(other)).toBe(other.API_KEY);
    expect(secret(natives)).toBe(natives.API_KEY);
    expect(() => flags({ FLAGS: { getBooleanValue: fn } })).toThrow(
      'is not a binding of type Flagship',
    );
    expect(() => secret({ API_KEY: 'secret-value' })).toThrow(
      'is not a binding of type Secrets Store secret',
    );
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
