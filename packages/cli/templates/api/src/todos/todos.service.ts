import { Injectable, InjectEnv, type VelaEnv } from '@velajs/vela';
import { InjectQueue, type QueueClient } from '@velajs/vela/queue';
import { TODO_EVENTS, todoCreated } from './todo-events.js';
import { Todo, type CreateTodo, type UpdateTodo } from './todo.schemas.js';

const PREFIX = 'todo:';

@Injectable()
export class TodosService {
  readonly #env: VelaEnv;
  readonly #events: QueueClient;

  // ENV carries the bindings wrangler.jsonc declares; `pnpm types` types them.
  constructor(@InjectEnv() env: VelaEnv, @InjectQueue(TODO_EVENTS) events: QueueClient) {
    this.#env = env;
    this.#events = events;
  }

  async list(): Promise<Todo[]> {
    const todos: Todo[] = [];
    let cursor: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- Each page starts at the previous cursor.
      const page = await this.#env.TODOS.list({ prefix: PREFIX, cursor });
      // eslint-disable-next-line no-await-in-loop
      const found = await Promise.all(page.keys.map((key) => this.#read(key.name)));
      for (const todo of found) if (todo) todos.push(todo);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return todos.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  find(id: string): Promise<Todo | undefined> {
    return this.#read(PREFIX + id);
  }

  async create(input: CreateTodo): Promise<Todo> {
    const todo: Todo = {
      id: crypto.randomUUID(),
      title: input.title,
      completed: false,
      createdAt: new Date().toISOString(),
    };
    await this.#env.TODOS.put(PREFIX + todo.id, JSON.stringify(todo));
    await this.#events.add(todoCreated, { id: todo.id, title: todo.title });
    return todo;
  }

  async update(id: string, input: UpdateTodo): Promise<Todo | undefined> {
    const existing = await this.find(id);
    if (!existing) return undefined;
    const todo: Todo = { ...existing, ...input };
    await this.#env.TODOS.put(PREFIX + id, JSON.stringify(todo));
    return todo;
  }

  async remove(id: string): Promise<boolean> {
    if (!(await this.find(id))) return false;
    await this.#env.TODOS.delete(PREFIX + id);
    return true;
  }

  /** Delete every completed todo; returns how many were removed. */
  async purgeCompleted(): Promise<number> {
    const completed = (await this.list()).filter((todo) => todo.completed);
    await Promise.all(completed.map((todo) => this.#env.TODOS.delete(PREFIX + todo.id)));
    return completed.length;
  }

  // Stored values come from outside this code: validate before trusting them.
  async #read(key: string): Promise<Todo | undefined> {
    const parsed = Todo.safeParse(await this.#env.TODOS.get(key, 'json'));
    return parsed.success ? parsed.data : undefined;
  }
}
