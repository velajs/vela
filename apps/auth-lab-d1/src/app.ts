import { betterAuth } from 'better-auth';
// Direct import: when Wrangler bundled the Worker with esbuild, the
// `better-auth/adapters/drizzle` re-export chain was wrapped in an async-init
// shim under workerd. The direct import does not depend on how a bundler
// handles that chain.
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import { Controller, ENV, Get, Module } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { BetterAuthModule, CurrentUser, Public, type User } from '@velajs/better-auth';
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

// The worker seeds this event's native environment as ENV before DI runs. The
// auth service builds once within that environment's application, with the D1
// binding typed by `wrangler types` (worker-configuration.d.ts).
@Module({
  imports: [
    BetterAuthModule.forRootAsync({
      inject: [ENV],
      useFactory: (env) => ({
        auth: () =>
          betterAuth({
            secret: 'auth-lab-d1-demo-secret-32-bytes-please-rotate',
            baseURL: 'http://localhost',
            // Pass the drizzle `schema` so the adapter maps better-auth's models
            // to typed tables — required on D1 so Date columns are encoded via
            // drizzle's `{ mode: 'timestamp' }` (a bare adapter throws
            // D1_TYPE_ERROR when better-auth writes a Date).
            database: drizzleAdapter(drizzle(env.DB, { schema }), {
              provider: 'sqlite',
              schema,
            }),
            emailAndPassword: { enabled: true, autoSignIn: true },
            trustedOrigins: ['http://localhost:8789', 'http://localhost'],
          }),
      }),
    }),
  ],
  controllers: [MeController, HealthController],
})
class AppModule {}

export const worker = createCloudflareWorker(AppModule);
