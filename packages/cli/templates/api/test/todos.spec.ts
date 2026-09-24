import { env } from 'cloudflare:workers';
import { createTestingWorker, queueJob } from '@velajs/cloudflare/testing';
import { Module } from '@velajs/vela';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { NotificationsModule } from '../src/notifications/notifications.module.js';
import { Notifier } from '../src/notifications/notifier.service.js';
import { TODO_EVENTS, todoCreated } from '../src/todos/todo-events.js';
import type { Todo } from '../src/todos/todo.schemas.js';
import { TodosService } from '../src/todos/todos.service.js';

// These specs run inside workerd with the bindings wrangler.jsonc declares.
// createTestingWorker() builds AppModule as src/worker.ts does, and drives the
// Worker's fetch, queue and scheduled handlers.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// Stands in for NotificationsModule; useMocker() supplies the Notifier it provided.
@Module({})
class SilentNotifications {}

describe('todos API', () => {
  it('creates, reads, updates and deletes a todo', async () => {
    const worker = await createTestingWorker(AppModule, { env });
    try {
      const created = await worker.fetch('/todos', json({ title: 'Write tests' }));
      expect(created.ok).toBe(true);
      const todo = await created.json<Todo>();
      expect(todo).toMatchObject({ title: 'Write tests', completed: false });

      const found = await worker.fetch(`/todos/${todo.id}`);
      expect(await found.json()).toEqual(todo);

      const updated = await worker.fetch(`/todos/${todo.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      });
      expect(await updated.json()).toEqual({ ...todo, completed: true });

      const removed = await worker.fetch(`/todos/${todo.id}`, { method: 'DELETE' });
      expect(removed.status).toBe(204);
      expect((await worker.fetch(`/todos/${todo.id}`)).status).toBe(404);
    } finally {
      await worker.close();
    }
  });

  it('rejects an invalid body', async () => {
    const worker = await createTestingWorker(AppModule, { env });
    try {
      const response = await worker.fetch('/todos', json({ title: '' }));
      expect(response.status).toBe(400);
    } finally {
      await worker.close();
    }
  });

  it('notifies when a todo.created job is processed', async () => {
    const notified: string[] = [];
    const worker = await createTestingWorker(AppModule, {
      env,
      overrides: (module) =>
        module
          .overrideModule(NotificationsModule)
          .useModule(SilentNotifications)
          .useMocker((token) =>
            token === Notifier
              ? { notify: (message: string) => notified.push(message) }
              : undefined,
          ),
    });
    try {
      const result = await worker.queue(TODO_EVENTS, [
        queueJob(TODO_EVENTS, todoCreated, { id: 'todo-1', title: 'Write tests' }),
      ]);
      expect(result.outcome).toBe('ok');
      expect(result.explicitAcks).toHaveLength(1);
      expect(notified).toEqual(['Todo created: Write tests']);
    } finally {
      await worker.close();
    }
  });

  it('purges completed todos on the nightly cron trigger', async () => {
    const worker = await createTestingWorker(AppModule, { env });
    try {
      const todos = worker.module.get(TodosService);
      const done = await todos.create({ title: 'Done' });
      await todos.update(done.id, { completed: true });
      const open = await todos.create({ title: 'Open' });

      await worker.scheduled('0 3 * * *');

      expect(await todos.find(done.id)).toBeUndefined();
      expect(await todos.find(open.id)).toEqual(open);
    } finally {
      await worker.close();
    }
  });
});
