import type { Context } from 'hono';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Res,
  WebSocketGateway,
  WebSocketModule,
} from '@velajs/vela';
import {
  LiveInvalidation,
  LiveModule,
  LiveQuery,
  LiveResolver,
  stampCommitHeaders,
} from '@velajs/vela/live';
import type { LiveModuleOptions } from '@velajs/vela/live';

export interface Todo {
  id: string;
  text: string;
  createdAt: number;
}

const SEED: Todo[] = [{ id: 'seed-1', text: 'Try opening this page in a second tab', createdAt: 0 }];

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

export const TODO_STORE = 'demo:todo-store';

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
@Injectable()
export class TodoLive {
  constructor(@Inject(TodosService) private readonly todos: TodosService) {}

  @LiveQuery('todos.list', { tags: ['todos'] })
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
    @Inject(TodosService) private readonly todos: TodosService,
    @Inject(LiveInvalidation) private readonly live: LiveInvalidation,
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
 * The live socket's gateway path — the client connects to /rooms/default/ws.
 * `binding` is only read by the Cloudflare transport (which forwards the
 * upgrade to that room's Durable Object); the node transport ignores it.
 */
@WebSocketGateway({ path: '/rooms/:id/ws', roomParam: 'id', binding: 'CHAT_ROOM' })
export class RoomsGateway {}

export interface MakeAppModuleOptions {
  live?: LiveModuleOptions;
  /** Extra imports (e.g. Cloudflare's KVModule) and the TodoStore provider. */
  imports?: unknown[];
  storeProvider?: unknown;
}

export function makeAppModule(options: MakeAppModuleOptions = {}): new () => object {
  const storeProvider = options.storeProvider ?? { provide: TODO_STORE, useValue: new MemoryTodoStore() };
  @Module({
    imports: [WebSocketModule.forRoot({}), LiveModule.forRoot(options.live ?? {}), ...((options.imports ?? []) as never[])],
    controllers: [TodosController],
    providers: [RoomsGateway, storeProvider as never, TodosService, TodoLive],
  })
  class AppModule {}
  return AppModule;
}
