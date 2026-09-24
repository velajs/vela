import { betterAuth } from 'better-auth';
import { drizzleAdapter as authAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  Controller,
  ENV,
  Get,
  InjectEnv,
  Module,
  defineProvider,
  type VelaEnv,
} from '@velajs/vela';
import { ApiResponse, OpenApiModule } from '@velajs/vela/openapi';
import { WebSocketGateway, WebSocketModule } from '@velajs/vela/websocket';
import { LiveModule, LiveQuery, LiveResolver } from '@velajs/vela/live';
import {
  BETTER_AUTH_UPGRADE_TENANT,
  BetterAuthModule,
  BetterAuthUpgradeAuthenticator,
  CurrentUser,
  Public,
  type BetterAuthUpgradeTenantResolver,
  type User,
} from '@velajs/better-auth';
import { Crud, CrudModule, defineModel } from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import { durableObjectRoomName } from '@velajs/cloudflare';
import { StudioModule } from '@velajs/studio';
import { StudioCrudModule } from '@velajs/studio/crud';
import { StudioLiveModule } from '@velajs/studio/live';
import { schema as authSchema } from './auth-schema';
import { todoSchema, todoList } from './contracts';

const GATEWAY = '/rooms/:room/ws';

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

@Controller('/me')
class MeController {
  @Get()
  @ApiResponse(200, {
    description: 'Current user',
    schema: {
      type: 'object',
      required: ['id', 'email', 'name'],
      properties: { id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } },
    },
  })
  me(@CurrentUser() user: User) {
    return { id: user.id, email: user.email, name: user.name };
  }
}

@Controller('/healthz')
class HealthController {
  @Get()
  @Public(true)
  @ApiResponse(200, {
    description: 'Healthy',
    schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
  })
  health() {
    return { ok: true };
  }
}

@LiveResolver()
class TodoQueries {
  constructor(@InjectEnv() private readonly native: VelaEnv) {}
  @LiveQuery('todos.list', todoList, { tags: ['crud:todos'] })
  async list() {
    const rows = await drizzle(this.native.DB).select().from(todos).orderBy(todos.id);
    return todoList.result.parse(rows);
  }
}

@WebSocketGateway({
  path: GATEWAY,
  roomParam: 'room',
  binding: 'LIVE_ROOM',
  allowedOrigins: (env) => [env.APP_ORIGIN],
  authenticator: BetterAuthUpgradeAuthenticator,
})
class TodoGateway {}

/**
 * The whole application, declared once. Each native environment builds its own
 * auth instance, CRUD adapter and Studio source in the factories below; secrets
 * never live in process-wide globals. The Cloudflare adapter wires WebSockets
 * and live queries to the LIVE_ROOM Durable Object that TodoGateway names.
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
      managedModels: { include: ['todo'] },
    }),
    StudioCrudModule.forRoot({}),
    StudioLiveModule.forRootAsync({
      inject: [ENV],
      useFactory: (env) => ({
        source: {
          inspect: () =>
            env.LIVE_ROOM.get(
              env.LIVE_ROOM.idFromName(durableObjectRoomName(GATEWAY, 'default')),
            ).inspectLive(),
        },
      }),
    }),
  ],
  controllers: [TodosController, MeController, HealthController],
  providers: [
    TodoGateway,
    TodoQueries,
    // BetterAuthUpgradeAuthenticator resolves from this module, so it sees this resolver.
    defineProvider(BETTER_AUTH_UPGRADE_TENANT, { useValue: sharedBoard }),
  ],
})
export class AppModule {}
