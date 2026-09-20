import { defineProvider, Inject, Injectable, InjectionToken } from '@velajs/vela';
import { LiveModule } from '@velajs/vela/live';
import {
  CloudflareWebSocketModule,
  createCloudflareWorker,
  durableObjectCursorLog,
  durableObjectLive,
} from '@velajs/cloudflare';
import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';
import { makeAppModule, TODO_STORE } from './app.module';
import type { Todo, TodoStore } from './app.module';
import { todoListDefinition } from './live-contract';

interface WorkerEnv {
  TODOS: KVNamespace;
  CHAT_ROOM: DurableObjectNamespace<LiveRoom>;
}

const ENV = new InjectionToken<WorkerEnv>('live-todo environment');

const SEED: Todo[] = [{ id: 'seed-1', text: 'Try opening this page in a second tab', createdAt: 0 }];
const KV_KEY = 'todos';

/**
 * KV-backed store: the Worker (mutations) and the Durable Object (live-query
 * re-runs) are separate app instances, so the data they share must live in a
 * shared binding — never in per-isolate memory.
 */
@Injectable()
class KvTodoStore implements TodoStore {
  constructor(@Inject(ENV) private readonly env: WorkerEnv) {}

  async all(): Promise<Todo[]> {
    const raw = await this.env.TODOS.get(KV_KEY);
    if (raw === null) return [...SEED];
    const parsed: unknown = JSON.parse(raw);
    return todoListDefinition.result.parse(parsed);
  }

  async add(text: string): Promise<Todo> {
    const todos = await this.all();
    const todo: Todo = { id: crypto.randomUUID(), text, createdAt: Date.now() };
    await this.env.TODOS.put(KV_KEY, JSON.stringify([...todos, todo]));
    return todo;
  }

  async remove(id: string): Promise<boolean> {
    const todos = await this.all();
    const next = todos.filter((todo) => todo.id !== id);
    if (next.length === todos.length) return false;
    await this.env.TODOS.put(KV_KEY, JSON.stringify(next));
    return true;
  }
}

// One module definition for both isolates: the Worker (HTTP mutations — its
// invalidations route to the room DO over the `invalidate` RPC and return the
// DO's commit stamp) and the Durable Object (sockets, cursor log, re-runs).
const AppModule = makeAppModule({
  liveModule: LiveModule.forRootAsync({
    inject: [ENV],
    useFactory: (env) => ({
      log: () => durableObjectCursorLog(),
      driver: () => durableObjectLive({ namespace: env.CHAT_ROOM, gatewayPath: '/rooms/:id/ws' }),
    }),
  }),
  websocketModule: CloudflareWebSocketModule.forRoot(),
  storeProvider: defineProvider(TODO_STORE, { useClass: KvTodoStore }),
});

/** wrangler `class_name` — must be in `migrations[].new_sqlite_classes` (the cursor log lives in DO SQLite). */
export class LiveRoom extends VelaWebSocketDurableObject(AppModule, { envToken: ENV }) {}

export default createCloudflareWorker(AppModule, { envToken: ENV });
