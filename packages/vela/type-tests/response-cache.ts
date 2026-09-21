import {
  CacheService,
  MemoryCacheStore,
  ResponseCacheService,
  MemoryCacheInvalidationStore,
  ResponseCacheModule,
  type ResponseCacheOptions,
  type AsyncCacheStore,
} from '../src/index';

const sync = new CacheService(new MemoryCacheStore());
const write: void = sync.set('key', 1);
const raw: unknown = sync.get('key');
const store: AsyncCacheStore = {
  async get() {
    return undefined;
  },
  async set() {},
  async del() {},
  async clear() {},
};
const options: ResponseCacheOptions = {
  namespace: 'types',
  store,
  scope: () => ({ visibility: 'private', partition: 'trusted' }),
  invalidation: new MemoryCacheInvalidationStore(),
};
ResponseCacheModule.forRoot(options);
ResponseCacheModule.forRootAsync({ inject: [], useFactory: async () => options });
const cache = new ResponseCacheService(options).scope({
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
new ResponseCacheService(options).scope({ partition: 'trusted' });
void [write, raw, parsed, read];
