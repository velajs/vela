// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  Cron,
  defineProvider,
  ENV,
  Inject,
  Injectable,
  InjectEnv,
  InjectionToken,
  Module,
  type VelaEnv,
} from '@velajs/vela';
import { LiveInvalidation, LiveModule } from '@velajs/vela/live';
import { createCloudflareApp, createCloudflareWorker } from '../../cloudflare-factory';
import { QueueConsumer } from '../../decorators/queue-consumer';
import { CloudflareWebSocketModule } from '../../websocket/cloudflare-websocket.module';
import { durableObjectLive } from '../../websocket/do-live';

describe('cold native bindings under workerd', () => {
  it.each(['queue', 'scheduled'] as const)(
    'reaches a real Durable Object from a cold %s handler',
    async (kind) => {
      const bookmarks: string[] = [];
      @Injectable()
      class Jobs {
        constructor(@InjectEnv() private readonly bindings: VelaEnv) {}
        @QueueConsumer('jobs')
        @Cron('* * * * *', { dialect: 'cloudflare' })
        async run(): Promise<void> {
          const namespace = this.bindings.TEST_ROOM;
          const room = namespace.get(namespace.idFromName(`cold-${kind}`));
          bookmarks.push((await room.pitrCurrentBookmark()).current);
        }
      }
      @Module({ providers: [Jobs] })
      class AppModule {}
      const worker = createCloudflareWorker(AppModule);
      const context = { waitUntil: (): void => {} };
      if (kind === 'queue') await worker.queue({ queue: 'jobs', messages: [] }, env, context);
      else await worker.scheduled({ cron: '* * * * *' }, env, context);
      expect(bookmarks).toHaveLength(1);
      expect(bookmarks[0]?.length).toBeGreaterThan(0);
    },
  );
  it.each(['queue', 'scheduled'] as const)(
    'performs live invalidation through a native DO on a cold %s event',
    async (kind) => {
      let dispatched = false;
      @Injectable()
      class Jobs {
        constructor(private readonly live: LiveInvalidation) {}
        @QueueConsumer('live-jobs')
        @Cron('* * * * *', { dialect: 'cloudflare' })
        async run(): Promise<void> {
          await this.live.invalidate({ tags: ['todos'] });
          dispatched = true;
        }
      }
      @Module({
        imports: [
          CloudflareWebSocketModule.forRoot(),
          LiveModule.forRootAsync({
            inject: [ENV],
            useFactory: (bindings: VelaEnv) => ({
              driver: () =>
                durableObjectLive({
                  namespace: bindings.TEST_ROOM,
                  gatewayPath: '/rooms/:room/ws',
                }),
            }),
          }),
        ],
        providers: [Jobs],
      })
      class AppModule {}
      const worker = createCloudflareWorker(AppModule);
      const context = { waitUntil: (): void => {} };
      if (kind === 'queue') await worker.queue({ queue: 'live-jobs', messages: [] }, env, context);
      else await worker.scheduled({ cron: '* * * * *' }, env, context);
      expect(dispatched).toBe(true);
    },
  );

  it('injects real KV, D1 and R2 before async provider factories and lifecycle', async () => {
    const CHECK = new InjectionToken<string>('native I/O result');
    const key = crypto.randomUUID();
    let lifecycleValue: string | undefined;
    @Injectable()
    class Lifecycle {
      constructor(@Inject(CHECK) private readonly result: string) {}
      onModuleInit() {
        lifecycleValue = this.result;
      }
    }
    @Module({
      providers: [
        Lifecycle,
        defineProvider(CHECK, {
          inject: [ENV],
          useFactory: async (bindings) => {
            await bindings.CACHE.put(key, 'native-kv');
            await bindings.FILES.put(key, 'native-r2');
            await bindings.DB.exec(
              'CREATE TABLE IF NOT EXISTS native_bindings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
            );
            await bindings.DB.prepare('INSERT INTO native_bindings (key, value) VALUES (?, ?)')
              .bind(key, 'native-d1')
              .run();
            expect(await bindings.CACHE.get(key)).toBe('native-kv');
            expect(await (await bindings.FILES.get(key))?.text()).toBe('native-r2');
            expect(
              await bindings.DB.prepare('SELECT value FROM native_bindings WHERE key = ?')
                .bind(key)
                .first('value'),
            ).toBe('native-d1');
            return 'all native bindings available';
          },
        }),
      ],
    })
    class AppModule {}
    const app = await createCloudflareApp(AppModule, { env });
    expect(lifecycleValue).toBe('all native bindings available');
    expect(app.get(CHECK)).toBe('all native bindings available');
    await app.close();
  });
});
