import { betterAuth } from 'better-auth';
import { drizzleAdapter as authAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  ApiResponse,
  Controller,
  Get,
  InjectEnv,
  Injectable,
  Module,
  WebSocketGateway,
  createOpenApiDocument,
  type VelaEnv,
} from '@velajs/vela';
import { LiveModule, LiveQuery, LiveResolver } from '@velajs/vela/live';
import { BetterAuthModule, CurrentUser, Public, type User } from '@velajs/better-auth';
import { Crud, CrudModule, defineModel } from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import {
  CloudflareWebSocketModule,
  durableObjectCursorLog,
  durableObjectLive,
  durableObjectRoomName,
} from '@velajs/cloudflare';
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

/** One graph per native environment; secrets never live in process-wide globals. */
export function createAppModule(env: VelaEnv) {
  const db = drizzle(env.DB, { schema: authSchema });
  const auth = betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_ORIGIN,
    database: authAdapter(db, { provider: 'sqlite', schema: authSchema }),
    emailAndPassword: { enabled: true, autoSignIn: true },
    user: { deleteUser: { enabled: true } },
    trustedOrigins: [env.APP_ORIGIN],
  });
  const adapter = drizzleAdapter({
    driver: 'd1',
    db: drizzle(env.DB),
    table: todos,
    parseRow: (value: unknown) => todoSchema.parse(value),
  });

  @Controller('/todos')
  @Crud({ model, adapter, live: { room: () => 'default' } })
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

  @Controller('/openapi.json')
  class OpenApiController {
    @Get()
    @Public(true)
    document() {
      return createOpenApiDocument(AppModule, {
        info: { title: 'Vela API starter', version: '1.0.0' },
      });
    }
  }

  @LiveResolver()
  @Injectable()
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
    allowedOrigins: [env.APP_ORIGIN],
    authenticateUpgrade: async (request, context) => {
      if (context.room !== 'default') return false;
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return false;
      return {
        principal: { issuer: 'api-starter', subject: session.user.id, principalType: 'user' },
        tenantId: 'shared-board',
        expiresAtMs: session.session.expiresAt.getTime(),
      };
    },
  })
  class TodoGateway {}

  @Module({
    imports: [
      BetterAuthModule.forRoot({ auth, issuer: 'api-starter' }),
      CrudModule.forRoot({ adapter }),
      CloudflareWebSocketModule.forRoot(),
      LiveModule.forRoot({
        log: () => durableObjectCursorLog(),
        driver: () => durableObjectLive({ namespace: env.LIVE_ROOM, gatewayPath: GATEWAY }),
      }),
      // Studio reads its VELA_STUDIO_TOKEN secret from ENV and stays closed without one.
      StudioModule.forRoot({
        rootModule: AppModule,
        editable: { ops: true },
        managedModels: { include: ['todo'] },
      }),
      StudioCrudModule.forRoot({}),
      StudioLiveModule.forRoot({
        source: {
          inspect: () =>
            env.LIVE_ROOM.get(
              env.LIVE_ROOM.idFromName(durableObjectRoomName(GATEWAY, 'default')),
            ).inspectLive(),
        },
      }),
    ],
    controllers: [TodosController, MeController, HealthController, OpenApiController],
    providers: [TodoGateway, TodoQueries],
  })
  class AppModule {}
  return AppModule;
}
