import { Inject, Injectable } from '@velajs/vela';
import {
  createCloudflareApp,
  durableObjectCursorLog,
  durableObjectLive,
  KVModule,
  KVService,
  VelaWebSocketDurableObject,
} from '@velajs/cloudflare';
import type { CloudflareApplication } from '@velajs/cloudflare';
import { makeAppModule, TODO_STORE } from './app.module';
import type { Todo, TodoStore } from './app.module';

const SEED: Todo[] = [{ id: 'seed-1', text: 'Try opening this page in a second tab', createdAt: 0 }];
const KV_KEY = 'todos';

/**
 * KV-backed store: the Worker (mutations) and the Durable Object (live-query
 * re-runs) are separate app instances, so the data they share must live in a
 * shared binding — never in per-isolate memory.
 */
@Injectable()
class KvTodoStore implements TodoStore {
  constructor(@Inject(KVService) private readonly kv: KVService) {}

  async all(): Promise<Todo[]> {
    const raw = await this.kv.namespace.get(KV_KEY);
    return raw ? (JSON.parse(raw) as Todo[]) : [...SEED];
  }

  async add(text: string): Promise<Todo> {
    const todos = await this.all();
    const todo: Todo = { id: crypto.randomUUID(), text, createdAt: Date.now() };
    await this.kv.namespace.put(KV_KEY, JSON.stringify([...todos, todo]));
    return todo;
  }

  async remove(id: string): Promise<boolean> {
    const todos = await this.all();
    const next = todos.filter((todo) => todo.id !== id);
    if (next.length === todos.length) return false;
    await this.kv.namespace.put(KV_KEY, JSON.stringify(next));
    return true;
  }
}

// One module definition for both isolates: the Worker (HTTP mutations — its
// invalidations route to the room DO over the `invalidate` RPC and return the
// DO's commit stamp) and the Durable Object (sockets, cursor log, re-runs).
const AppModule = makeAppModule({
  live: {
    log: durableObjectCursorLog(),
    driver: durableObjectLive({ binding: 'CHAT_ROOM', gatewayPath: '/rooms/:id/ws' }),
  },
  imports: [KVModule.forRoot({ binding: 'TODOS' })],
  storeProvider: { provide: TODO_STORE, useClass: KvTodoStore },
});

/** wrangler `class_name` — must be in `migrations[].new_sqlite_classes` (the cursor log lives in DO SQLite). */
export class LiveRoom extends VelaWebSocketDurableObject(AppModule) {}

let appPromise: Promise<CloudflareApplication> | undefined;

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Promise<Response> {
    appPromise ??= createCloudflareApp(AppModule);
    const app = await appPromise;
    return app.fetch(request, env as never, ctx as never);
  },
};
