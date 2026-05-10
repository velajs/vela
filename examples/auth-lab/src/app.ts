import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  VelaFactory,
} from '@velajs/vela';
import {
  BETTER_AUTH,
  BetterAuthModule,
  CurrentSession,
  CurrentUser,
  Public,
  type BetterAuthInstance,
  type Session,
  type User,
} from '@velajs/better-auth';

// In-memory store — better-auth's memoryAdapter is edge-safe (no node:*, no Buffer).
// Replace with drizzleAdapter(drizzle(env.DB), { provider: 'sqlite' }) for D1, etc.
const memory: Record<string, unknown[]> = {
  user: [],
  session: [],
  account: [],
  verification: [],
};

const auth = betterAuth({
  // 32-byte secret for HMAC of session tokens. In production, source from env.
  secret: 'auth-lab-demo-secret-key-32-bytes-please-rotate',
  // baseURL drives cookie domain + Origin checks. Hono's in-process request()
  // delivers requests as if from this origin, so set it explicitly.
  baseURL: 'http://localhost',
  database: memoryAdapter(memory),
  emailAndPassword: { enabled: true, autoSignIn: true },
  trustedOrigins: ['http://localhost:8787', 'http://localhost'],
});

// A vela service that uses the better-auth instance via DI. This is the
// "access in services or controllers" pattern: any @Injectable can
// @Inject(BETTER_AUTH) and call auth.api.* directly.
@Injectable()
class StatsService {
  // The auth instance is injected, not imported — keeps the service decoupled
  // from the global module-level `auth` const and makes it overridable in tests.
  constructor(@Inject(BETTER_AUTH) private readonly auth: BetterAuthInstance) {}

  userCount(): number {
    return memory.user.length;
  }

  hasSessionFor(userId: string): boolean {
    return memory.session.some((s: any) => s.userId === userId);
  }
}

@Controller('/me')
class MeController {
  @Get()
  me(@CurrentUser() user: User) {
    // The lazy proxy materializes on property access; safe here because
    // AuthGuard is global and unauthenticated requests never reach this handler.
    return { id: user.id, email: user.email, name: user.name };
  }

  @Get('/session')
  session(@CurrentSession() s: Session) {
    return { sessionId: s.id, userId: s.userId };
  }
}

@Controller('/stats')
class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  @Public(true)
  total() {
    return { users: this.stats.userCount() };
  }
}

@Module({
  imports: [BetterAuthModule.forRoot({ auth, isGlobal: true })],
  controllers: [MeController, StatsController],
  providers: [StatsService],
})
class AppModule {}

export async function createApp() {
  return await VelaFactory.create(AppModule);
}

// Re-export the auth instance so smoke.ts can read internal state if needed.
export { auth };
