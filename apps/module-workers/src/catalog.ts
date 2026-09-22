import { Injectable, InjectionToken, Module } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { Rpc, RpcModule } from '@velajs/rpc/server';
import { catalog } from './contracts';
@Injectable()
class CatalogService {
  @Rpc(catalog) read(id: string) {
    return { id, label: 'Example document' };
  }
}
@Module({ providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}
// This worker has no public route or workers.dev exposure. The binding grants access.
@Module({ imports: [CatalogModule, RpcModule.forRoot({ authorize: 'public' })] })
class CatalogWorkerModule {}
export default createCloudflareWorker(CatalogWorkerModule, {
  envToken: new InjectionToken<object>('catalog environment'),
});
