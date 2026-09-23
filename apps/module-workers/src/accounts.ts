import { Injectable, Module } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { Rpc, RpcModule } from '@velajs/rpc/server';
import { account } from './contracts';
@Injectable()
class AccountService {
  @Rpc(account) read(id: string) {
    return { id, active: true };
  }
}
@Module({ providers: [AccountService], exports: [AccountService] })
export class AccountsModule {}
@Module({ imports: [AccountsModule, RpcModule.forRoot({ authorize: 'public' })] })
class AccountsWorkerModule {}
export default createCloudflareWorker(AccountsWorkerModule);
