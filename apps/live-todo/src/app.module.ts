import type { Context } from 'hono';
import {
  Body,
  Controller,
  Delete,
  defineProvider,
  Get,
  Inject,
  InjectEnv,
  Injectable,
  InjectionToken,
  Module,
  Optional,
  Param,
  Post,
  Res,
  type VelaEnv,
} from '@velajs/vela';
import { WebSocketGateway, WebSocketModule } from '@velajs/vela/websocket';
import type { UpgradeAuthenticator, WebSocketUpgradeIdentity } from '@velajs/vela/websocket';
import {
  LiveInvalidation,
  LiveModule,
  LiveQuery,
  LiveResolver,
  stampCommitHeaders,
} from '@velajs/vela/live';
import { todoListDefinition } from './live-contract.js';
import type { Todo } from './live-contract.js';

export type { Todo } from './live-contract.js';

const SEED: Todo[] = [
  { id: 'seed-1', text: 'Try opening this page in a second tab', createdAt: 0 },
];

/**
 * The demo's "database" seam. CRITICAL on Cloudflare: the Worker (HTTP
 * mutations) and the Durable Object (live-query re-runs) are SEPARATE app
 * instances — state both must see has to live in a shared store (KV here;
 * D1/Postgres in real apps). Per-isolate memory would make writes invisible
 * to the re-runs.
 */
export interface TodoStore {
  all(): Promise<Todo[]>;
  add(text: string): Promise<Todo>;
  remove(id: string): Promise<boolean>;
}

export const TODO_STORE = new InjectionToken<TodoStore>('demo:todo-store');

/** node variant: one process, one memory. */
export class MemoryTodoStore implements TodoStore {
  private readonly todos: Todo[] = [...SEED];

  async all(): Promise<Todo[]> {
    return [...this.todos];
  }

  async add(text: string): Promise<Todo> {
    const todo: Todo = { id: crypto.randomUUID(), text, createdAt: Date.now() };
    this.todos.push(todo);
    return todo;
  }

  async remove(id: string): Promise<boolean> {
    const index = this.todos.findIndex((todo) => todo.id === id);
    if (index === -1) return false;
    this.todos.splice(index, 1);
    return true;
  }
}

/** The key-value operations the shared store uses (a Workers KV namespace provides them). */
interface TodoKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

const KV_KEY = 'todos';

/**
 * Cloudflare variant: todos in the TODOS KV namespace, which the Worker and
 * the Durable Object both bind. The example's read-modify-write store
 * illustrates sharing and does not provide concurrent-write atomicity.
 */
export class KvTodoStore implements TodoStore {
  constructor(private readonly kv: TodoKv) {}

  async all(): Promise<Todo[]> {
    const raw = await this.kv.get(KV_KEY);
    if (raw === null) return [...SEED];
    const parsed: unknown = JSON.parse(raw);
    return todoListDefinition.result.parse(parsed);
  }

  async add(text: string): Promise<Todo> {
    const todos = await this.all();
    const todo: Todo = { id: crypto.randomUUID(), text, createdAt: Date.now() };
    await this.kv.put(KV_KEY, JSON.stringify([...todos, todo]));
    return todo;
  }

  async remove(id: string): Promise<boolean> {
    const todos = await this.all();
    const next = todos.filter((todo) => todo.id !== id);
    if (next.length === todos.length) return false;
    await this.kv.put(KV_KEY, JSON.stringify(next));
    return true;
  }
}

/** The environment's TODOS namespace, validated as the operations the store calls. */
function readTodoKv(env: VelaEnv | undefined): TodoKv | undefined {
  const binding: unknown = env ? Reflect.get(env, 'TODOS') : undefined;
  if (typeof binding !== 'object' || binding === null) return undefined;
  const get: unknown = Reflect.get(binding, 'get');
  const put: unknown = Reflect.get(binding, 'put');
  if (typeof get !== 'function' || typeof put !== 'function') return undefined;
  return {
    get: async (key) => {
      const value: unknown = await Reflect.apply(get, binding, [key]);
      return typeof value === 'string' ? value : null;
    },
    put: async (key, value) => {
      await Reflect.apply(put, binding, [key, value]);
    },
  };
}

/**
 * Picks where todos live for each application: the TODOS namespace when its
 * environment binds one (the Worker and its Durable Object), process memory
 * otherwise (the node host, which seeds no environment).
 */
@Injectable()
export class TodoStoreFactory {
  constructor(@Optional() @InjectEnv() private readonly env?: VelaEnv) {}

  create(): TodoStore {
    const kv = readTodoKv(this.env);
    return kv ? new KvTodoStore(kv) : new MemoryTodoStore();
  }
}

@Injectable()
export class TodosService {
  constructor(@Inject(TODO_STORE) private readonly store: TodoStore) {}

  all(): Promise<Todo[]> {
    return this.store.all();
  }

  add(text: string): Promise<Todo> {
    return this.store.add(text);
  }

  remove(id: string): Promise<boolean> {
    return this.store.remove(id);
  }
}

/** The live query: re-runs and pushes whenever the 'todos' tag is invalidated. */
@LiveResolver()
export class TodoLive {
  constructor(private readonly todos: TodosService) {}

  @LiveQuery('todos.list', todoListDefinition, { tags: ['todos'] })
  list(): Promise<Todo[]> {
    return this.todos.all();
  }
}

/**
 * Plain HTTP mutations. `invalidate()` re-runs every affected subscription;
 * with `ambientContainer: true` (node) it also stamps Vela-Commit-Cursor /
 * Vela-Commit-Epoch on this response — what the client's optimistic layers
 * gate their drop on.
 */
@Controller('/todos')
export class TodosController {
  constructor(
    private readonly todos: TodosService,
    private readonly live: LiveInvalidation,
  ) {}

  @Get()
  list(): Promise<Todo[]> {
    return this.todos.all();
  }

  @Post()
  async create(@Body() body: { text?: string }, @Res() c: Context): Promise<Todo> {
    const todo = await this.todos.add(body.text ?? '(empty)');
    const stamp = await this.live.invalidate({ tags: ['todos'] });
    // Explicit stamping works on every runtime. (ambientContainer stamps
    // automatically on node, but hono's ALS contextStorage middleware hangs
    // responses under workerd when a Durable Object RPC is awaited inside it.)
    if (stamp) stampCommitHeaders(c, stamp);
    return todo;
  }

  @Delete('/:id')
  async remove(@Param('id') id: string, @Res() c: Context): Promise<{ removed: boolean }> {
    const removed = await this.todos.remove(id);
    if (removed) {
      const stamp = await this.live.invalidate({ tags: ['todos'] });
      if (stamp) stampCommitHeaders(c, stamp);
    }
    return { removed };
  }
}

/**
 * DEMO ONLY: admits every upgrade as a fresh anonymous visitor so the demo
 * runs without an auth stack. Gateways reject upgrades that name no
 * `authenticator`; a real application verifies a session cookie or a
 * short-lived socket ticket here and returns that user's identity. Each
 * application resolves this class through dependency injection, so a real
 * authenticator can inject its session service.
 */
@Injectable()
export class AnonymousDemoAuthenticator implements UpgradeAuthenticator {
  authenticate(): WebSocketUpgradeIdentity {
    return {
      principal: {
        issuer: 'live-todo-demo',
        subject: `anonymous:${crypto.randomUUID()}`,
        principalType: 'user',
      },
      tenantId: 'demo',
      expiresAtMs: Date.now() + 60 * 60 * 1000,
    };
  }
}

/**
 * The live socket's gateway path — the client connects to /rooms/default/ws.
 * `binding` is only read by the Cloudflare transport (which forwards the
 * upgrade to that room's Durable Object); the node transport ignores it.
 */
@WebSocketGateway({
  path: '/rooms/:id/ws',
  roomParam: 'id',
  binding: 'CHAT_ROOM',
  authenticator: AnonymousDemoAuthenticator,
})
export class RoomsGateway {}

/**
 * The application, declared once for both runtimes. On node, the host serves
 * the gateway in this process (registerWebSocketGateways) and LiveModule
 * delivers locally. On Workers, the Cloudflare adapter forwards each upgrade
 * to the room's LiveRoom Durable Object (the gateway's CHAT_ROOM binding), and
 * LiveModule sends Worker invalidations there; inside that object, delivery is
 * local and the cursor log lives in its SQLite storage.
 */
@Module({
  imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
  controllers: [TodosController],
  providers: [
    RoomsGateway,
    TodosService,
    TodoLive,
    TodoStoreFactory,
    defineProvider(TODO_STORE, {
      useFactory: (stores: TodoStoreFactory) => stores.create(),
      inject: [TodoStoreFactory],
    }),
  ],
})
export class AppModule {}
