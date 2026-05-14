import { betterAuth } from 'better-auth';
// Import directly from the underlying package rather than the `better-auth/adapters/memory`
// re-export. The re-export uses `export * from '@better-auth/memory-adapter'`, which esbuild
// (used by Wrangler) wraps in an async init shim — top-level calls to `memoryAdapter()` then
// observe `undefined`. The direct import resolves to a real ESM binding at module evaluation
// time, sidestepping the bundler-induced hazard.
import { memoryAdapter } from '@better-auth/memory-adapter';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  VelaFactory,
} from '@velajs/vela';
import {
  BetterAuthModule,
  BetterAuthService,
  CurrentSession,
  CurrentUser,
  Public,
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
  // and curl-via-wrangler both deliver requests as if from this origin.
  baseURL: 'http://localhost',
  database: memoryAdapter(memory),
  emailAndPassword: { enabled: true, autoSignIn: true },
  trustedOrigins: ['http://localhost:8787', 'http://localhost'],
});

// A vela service that uses the better-auth surface via DI. This is the
// canonical "access in services or controllers" pattern: any @Injectable
// can @Inject(BetterAuthService) and call `.api.*` / `.handler` / `.auth`
// — the service exposes the underlying betterAuth() instance through a
// lazy-cached field, matching NestJS service-injection idioms.
@Injectable()
class StatsService {
  constructor(
    @Inject(BetterAuthService) private readonly authService: BetterAuthService,
  ) {}

  userCount(): number {
    // BetterAuthService.api / .auth / .handler are available here. The
    // memory adapter's tables happen to be a module-level const we can
    // count directly; a real app would query through authService.api.
    void this.authService;
    return memory.user.length;
  }

  hasSessionFor(userId: string): boolean {
    return memory.session.some(
      (s) => (s as { userId?: string }).userId === userId,
    );
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
