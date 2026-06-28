import { betterAuth } from 'better-auth';
// Direct import — `better-auth/adapters/drizzle` triggers esbuild's
// async-init shim under workerd. Direct import avoids it (same hazard
// auth-lab encountered with memoryAdapter).
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import { Controller, Get, Module } from '@velajs/vela';
import { D1Module, D1Service, createCloudflareApp } from '@velajs/cloudflare';
import {
  BetterAuthModule,
  CurrentUser,
  Public,
  type User,
} from '@velajs/better-auth';
import { schema } from './schema';

@Controller('/me')
class MeController {
  @Get()
  me(@CurrentUser() user: User) {
    return { id: user.id, email: user.email, name: user.name };
  }
}

@Controller('/healthz')
class HealthController {
  @Get()
  @Public(true)
  ok() {
    return { ok: true };
  }
}

// forRootAsync defers `useFactory` until first `BetterAuthService.auth`
// access. That happens inside `AuthGuard.canActivate` (or the catch-all
// `/api/auth/*` handler), by which point `@velajs/cloudflare`'s
// middleware has populated env.DB and `d1.database` is safe to read.
@Module({
  imports: [
    D1Module.forRoot({ binding: 'DB' }),
    BetterAuthModule.forRootAsync({
      inject: [D1Service],
      useFactory: (d1: D1Service) =>
        betterAuth({
          secret: 'auth-lab-d1-demo-secret-32-bytes-please-rotate',
          baseURL: 'http://localhost',
          // Pass the drizzle `schema` so the adapter maps better-auth's models
          // to typed tables — required on D1 so Date columns are encoded via
          // drizzle's `{ mode: 'timestamp' }` (a bare adapter throws
          // D1_TYPE_ERROR when better-auth writes a Date).
          database: drizzleAdapter(drizzle(d1.database, { schema }), {
            provider: 'sqlite',
            schema,
          }),
          emailAndPassword: { enabled: true, autoSignIn: true },
          trustedOrigins: ['http://localhost:8789', 'http://localhost'],
        }),
      isGlobal: true,
    }),
  ],
  controllers: [MeController, HealthController],
})
class AppModule {}

export async function createApp() {
  // `createCloudflareApp` installs the one-time middleware that captures
  // `env` on first fetch and initializes every BindingRef (D1, KV, R2, ...).
  // Without it, `d1.database` throws `binding not initialized`.
  return await createCloudflareApp(AppModule);
}
