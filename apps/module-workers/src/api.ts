import { Controller, Get, Inject, InjectionToken, Module, Post } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { cloudflareQueueDriver } from '@velajs/cloudflare/queue';
import { QueueModule, queueToken, type QueueClient, type QueueJob } from '@velajs/vela/queue';
import { RpcClientModule, rpcClientToken } from '@velajs/rpc/server';
import type { RpcClient } from '@velajs/rpc';
import { account, catalog } from './contracts';
interface Env {
  CATALOG: Fetcher;
  ACCOUNTS: Fetcher;
  TASKS: Queue<QueueJob>;
}
const ENV = new InjectionToken<Env>('API environment');
@Controller('/api')
class ApiController {
  constructor(
    @Inject(rpcClientToken('catalog')) private catalogClient: RpcClient,
    @Inject(rpcClientToken('accounts')) private accountsClient: RpcClient,
    @Inject(queueToken('tasks')) private tasks: QueueClient,
  ) {}
  @Get('/document') async document() {
    const [document, owner] = await Promise.all([
      this.catalogClient.call(catalog, 'document-1'),
      this.accountsClient.call(account, 'account-1'),
    ]);
    return { document, owner };
  }
  @Post('/tasks') async enqueue() {
    await this.tasks.add('record', { source: 'api' });
    return { accepted: true };
  }
}
@Module({
  imports: [
    RpcClientModule.registerAsync({
      name: 'catalog',
      binding: 'CATALOG',
      inject: [ENV],
      useFactory: (env) => ({ url: 'https://catalog/rpc', fetch: env.CATALOG }),
    }),
    RpcClientModule.registerAsync({
      name: 'accounts',
      binding: 'ACCOUNTS',
      inject: [ENV],
      useFactory: (env) => ({ url: 'https://accounts/rpc', fetch: env.ACCOUNTS }),
    }),
    QueueModule.forRootAsync({
      queues: ['tasks'],
      inject: [ENV],
      useFactory: (env) => ({
        driver: cloudflareQueueDriver(
          { tasks: env.TASKS },
          { producerBindings: { tasks: 'TASKS' } },
        ),
      }),
    }),
  ],
  controllers: [ApiController],
})
class ApiModule {}
export default createCloudflareWorker(ApiModule, { envToken: ENV });
