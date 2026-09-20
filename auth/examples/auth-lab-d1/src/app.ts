import { betterAuth } from 'better-auth';
// Direct import — `better-auth/adapters/drizzle` triggers esbuild's
// async-init shim under workerd. Direct import avoids it (same hazard
// auth-lab encountered with memoryAdapter).
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import { Controller, Get, InjectionToken, Module } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import {
  BetterAuthModule,
  CurrentUser,
  Public,
  type User,
} from '@velajs/better-auth';
import { schema } from './schema';

interface WorkerEnv { DB: D1Database; }
const WORKER_ENV = new InjectionToken<WorkerEnv>('auth-lab-d1.Env');

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

// The worker installs this event's native environment before DI runs. The auth
// service builds once within that environment's application, with the typed D1 binding.
@Module({
  imports: [
    BetterAuthModule.forRootAsync({
      inject: [WORKER_ENV],
      useFactory: (env) =>
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
      isGlobal: true,
    }),
  ],
  controllers: [MeController, HealthController],
})
class AppModule {}

export const worker = createCloudflareWorker(AppModule, { envToken: WORKER_ENV });
