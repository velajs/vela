import { betterAuth } from 'better-auth';
import { drizzleAdapter as authAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  APP_GUARD,
  Controller,
  ENV,
  Get,
  InjectEnv,
  Module,
  defineProvider,
  type VelaEnv,
} from '@velajs/vela';
import { OpenApiModule } from '@velajs/vela/openapi';
import { WebSocketGateway, WebSocketModule } from '@velajs/vela/websocket';
import { LiveModule, LiveQuery, LiveResolver } from '@velajs/vela/live';
import {
  BETTER_AUTH_UPGRADE_TENANT,
  AuthGuard,
  BetterAuthModule,
  BetterAuthUpgradeAuthenticator,
  CurrentUser,
  Public,
  type BetterAuthUpgradeTenantResolver,
  type User,
} from '@velajs/better-auth';
import { Crud, CrudModule, crudLiveTag, defineModel } from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import { StudioModule } from '@velajs/studio';
import { crudPanel } from '@velajs/studio/crud';
import { livePanel } from '@velajs/studio/live';
import { schema as authSchema } from './auth-schema';
import { health, meSchema, todoSchema, todoList } from './contracts';

const todos = sqliteTable('todos', {
  id: text().primaryKey(),
  title: text().notNull(),
  done: integer({ mode: 'boolean' }).notNull().default(false),
});
const model = defineModel({
  name: 'todo',
  tableName: 'todos',
  schema: todoSchema,
  timestamps: false,
});

/** Every signed-in user shares one board, reached only through its `default` room. */
const sharedBoard: BetterAuthUpgradeTenantResolver = (_session, { room }) =>
  room === 'default' ? 'shared-board' : undefined;

// CrudModule supplies the adapter each environment builds below.
@Controller('/todos')
@Crud({ model, live: { room: () => 'default' } })
class TodosController {}

// Route options: the response schema strips the session user to these fields,
// documents them and types the generated client.
@Controller('/me')
class MeController {
  @Get({ response: meSchema })
  me(@CurrentUser() user: User) {
    return user;
  }
}

// A shared `defineRoute` contract: a browser can type a client from it alone.
@Controller('/healthz')
class HealthController {
  @Get(health)
  @Public(true)
  health() {
    return { ok: true };
  }
}

// The engine validates each result against todoList, so the query returns its rows as read.
@LiveResolver()
class TodoQueries {
  constructor(@InjectEnv() private readonly native: VelaEnv) {}
  @LiveQuery(todoList, { tags: [crudLiveTag('todos')] })
  async list() {
    return await drizzle(this.native.DB).select().from(todos).orderBy(todos.id);
  }
}

@WebSocketGateway({
  path: '/rooms/:room/ws',
  roomParam: 'room',
  binding: 'LIVE_ROOM',
  allowedOrigins: (env) => [env.APP_ORIGIN],
  authenticator: BetterAuthUpgradeAuthenticator,
})
class TodoGateway {}

/**
 * The whole application, declared once. Each native environment builds its own
 * auth instance and CRUD adapter in the factories below; secrets never live in
 * process-wide globals. The Cloudflare adapter wires WebSockets, live queries
 * and Studio's live inspection to the LIVE_ROOM Durable Object that
 * TodoGateway names.
 */
@Module({
  imports: [
    BetterAuthModule.forRootAsync({
      inject: [ENV],
      useFactory: (env) => ({
        issuer: 'api-starter',
        // Built on first authentication, not while the application initializes.
        auth: () =>
          betterAuth({
            secret: env.BETTER_AUTH_SECRET,
            baseURL: env.APP_ORIGIN,
            database: authAdapter(drizzle(env.DB, { schema: authSchema }), {
              provider: 'sqlite',
              schema: authSchema,
            }),
            emailAndPassword: { enabled: true, autoSignIn: true },
            user: { deleteUser: { enabled: true } },
            trustedOrigins: [env.APP_ORIGIN],
          }),
      }),
    }),
    CrudModule.forRootAsync({
      inject: [ENV],
      useFactory: (env) => ({
        adapter: drizzleAdapter({
          driver: 'd1',
          db: drizzle(env.DB),
          table: todos,
          parseRow: (value: unknown) => todoSchema.parse(value),
        }),
      }),
    }),
    WebSocketModule.forRoot(),
    LiveModule.forRoot(),
    OpenApiModule.forRoot({
      path: '/openapi.json',
      info: { title: 'Vela API starter', version: '1.0.0' },
    }),
    // Studio documents this module (ROOT_MODULE) and reads its VELA_STUDIO_TOKEN
    // secret from ENV; it stays closed without one.
    StudioModule.forRoot({
      editable: { ops: true },
      plugins: [
        crudPanel({ managedModels: { include: ['todo'] } }),
        // Studio inspects the shared board's room in its Durable Object.
        livePanel({ rooms: ['default'] }),
      ],
    }),
  ],
  controllers: [TodosController, MeController, HealthController],
  providers: [
    { provide: APP_GUARD, useExisting: AuthGuard },
    TodoGateway,
    TodoQueries,
    // BetterAuthUpgradeAuthenticator resolves from this module, so it sees this resolver.
    defineProvider(BETTER_AUTH_UPGRADE_TENANT, { useValue: sharedBoard }),
  ],
})
export class AppModule {}
