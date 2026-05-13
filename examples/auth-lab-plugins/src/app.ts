import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { Controller, Get, Module, VelaFactory } from '@velajs/vela';
import {
  BetterAuthModule,
  CurrentUser,
  Public,
  type User,
} from '@velajs/better-auth';
import {
  MAGIC_LINK_PLUGIN,
  MagicLinkAuthModule,
} from './magic-link-auth.module.js';

const memory: Record<string, unknown[]> = {
  user: [],
  session: [],
  account: [],
  verification: [],
};

@Controller('/me')
class MeController {
  @Get()
  me(@CurrentUser() user: User) {
    return { id: user.id, email: user.email };
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

// Pattern B (DI'd construction) + Pattern C (modular plugin contribution):
// `forRootAsync` resolves MagicLinkAuthModule's exported plugin token and
// composes it into the betterAuth({...}) factory. The feature module owns
// its own DI surface (EmailService); only the public plugin token crosses
// the boundary.
@Module({
  imports: [
    MagicLinkAuthModule,
    BetterAuthModule.forRootAsync({
      imports: [MagicLinkAuthModule],
      inject: [MAGIC_LINK_PLUGIN],
      useFactory: (magicLinkPlugin: unknown) => ({
        auth: betterAuth({
          secret: 'auth-lab-plugins-demo-secret-32-bytes-please-rotate',
          baseURL: 'http://localhost',
          database: memoryAdapter(memory),
          // emailAndPassword stays on for sign-up — the magic link plugin
          // uses an existing user identity by default.
          emailAndPassword: { enabled: true, autoSignIn: true },
          trustedOrigins: ['http://localhost:8787', 'http://localhost'],
          plugins: [magicLinkPlugin as never],
        }),
        isGlobal: true,
      }),
    }),
  ],
  controllers: [MeController, HealthController],
})
class AppModule {}

export async function createApp() {
  return await VelaFactory.create(AppModule);
}
