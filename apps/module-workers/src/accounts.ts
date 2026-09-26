import { Injectable, Module } from '@velajs/vela';
import { defineCloudflareApp } from '@velajs/cloudflare';
import { Rpc, RpcModule } from '@velajs/rpc/server';
import { VelaEntrypoint } from '@velajs/cloudflare/entrypoints';
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
// Fixture credential records emulate a server-side session lookup. Caller props
// and claimed user IDs never enter this verifier's output.
@Injectable()
class IdentityHost {
  verify(credential: unknown) {
    const records = new Map([
      ['fixture-alice', { subject: 'alice', roles: ['reader'], catalog: true }],
      ['fixture-bob', { subject: 'bob', roles: ['reader'], catalog: true }],
      ['fixture-no-permission', { subject: 'alice', roles: [], catalog: true }],
      ['fixture-no-resource', { subject: 'alice', roles: ['reader'], catalog: false }],
    ]);
    const record = typeof credential === 'string' ? records.get(credential) : undefined;
    if (!record) return null;
    return {
      principal: { issuer: 'example-accounts', subject: record.subject, principalType: 'user' },
      expiresAtMs: Date.now() + 60_000,
      roles: record.roles,
      claims: { catalog: record.catalog },
    };
  }
}
@Injectable()
class MembershipHost {
  admits(subject: string, tenantId: string) {
    return (
      (subject === 'alice' && tenantId === 'team-a') || (subject === 'bob' && tenantId === 'team-b')
    );
  }
}
const app = defineCloudflareApp(AccountsWorkerModule);
export class Identity extends VelaEntrypoint(app, IdentityHost, { rpc: ['verify'] }) {}
export class Membership extends VelaEntrypoint(app, MembershipHost, { rpc: ['admits'] }) {}
export default app.worker;
