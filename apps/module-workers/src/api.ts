import { Controller, ENV, Get, Inject, Module, Post } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { cloudflareQueueDriver } from '@velajs/cloudflare/queue';
import { QueueModule, queueToken, type QueueClient } from '@velajs/vela/queue';
import { RpcClientModule, rpcClientToken } from '@velajs/rpc/server';
import type { RpcClient } from '@velajs/rpc';
import { account, catalog } from './contracts';
// ENV carries this Worker's bindings, typed by worker-configuration.api.d.ts.
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
export default createCloudflareWorker(ApiModule);
