import {
  CacheModule,
  CacheService,
  MemoryCacheStore,
  MemoryCacheInvalidationStore,
  type CacheModuleOptions,
  type CacheStore,
} from '../src/cache/index';
import { ENV, type VelaEnv } from '../src/index';

const store: CacheStore = {
  async get() {
    return undefined;
  },
  async set() {},
  async del() {},
  async clear() {},
};
// A synchronous store is a CacheStore too.
const memory: CacheStore = new MemoryCacheStore();
const options: CacheModuleOptions = {
  namespace: 'types',
  store,
  scope: () => ({ visibility: 'private', partition: 'trusted' }),
  invalidation: new MemoryCacheInvalidationStore(),
};
CacheModule.forRoot(options);
// The store defaults to memory; a function of ENV builds one per application.
CacheModule.forRoot({ namespace: 'types', scope: () => undefined });
CacheModule.forRoot({
  namespace: 'types',
  scope: () => undefined,
  store: (_env: VelaEnv) => memory,
});
CacheModule.forRootAsync({ useFactory: async () => options });
CacheModule.forRootAsync({ inject: [ENV], useFactory: (_env: VelaEnv) => options });
const cache = new CacheService(options).scope({
  visibility: 'private',
  partition: 'trusted',
});
const parsed: Promise<number | undefined> = cache.getParsed('key', (value) => {
  if (typeof value !== 'number') throw Error('Invalid cached number');
  return value;
});
const read: Promise<unknown> = cache.get('key');
// @ts-expect-error raw persisted values are unknown, even when callers specify a type
cache.get<number>('key');
// @ts-expect-error a trusted partition must explicitly choose public or private visibility
new CacheService(options).scope({ partition: 'trusted' });
// @ts-expect-error namespace and scope are mandatory
CacheModule.forRoot({ store });
void [parsed, read];
