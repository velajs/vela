import { LiveClient } from '@velajs/client';
import type { WebSocketLike } from '@velajs/client';
import { createPresence } from '@velajs/client/presence';

interface Todo {
  id: string;
  text: string;
  optimistic?: boolean;
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const wirePanel = el<HTMLDivElement>('wire');

function logWire(direction: 'out' | 'in', raw: unknown): void {
  if (typeof raw !== 'string') return;
  try {
    const envelope = JSON.parse(raw) as { event?: string; data?: { t?: string; cursor?: number; epoch?: string } };
    if (envelope.event !== '$live') return;
    const { t, cursor, epoch } = envelope.data ?? {};
    const line = document.createElement('div');
    line.className = direction;
    const stamp = cursor !== undefined ? `  cursor=${cursor} epoch=${(epoch ?? '').slice(0, 8)}` : '';
    line.textContent = `${direction === 'out' ? '→' : '←'} ${t}${stamp}`;
    wirePanel.append(line);
    wirePanel.scrollTop = wirePanel.scrollHeight;
  } catch {
    /* not an envelope */
  }
}

let activeSocket: WebSocket | undefined;

/** Wrap the native WebSocket so every $live frame lands in the panel. */
function observedSocket(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  activeSocket = ws;
  const wrapped: WebSocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    get readyState() {
      return ws.readyState;
    },
    send(data: string) {
      logWire('out', data);
      ws.send(data);
    },
    close(code?: number, reason?: string) {
      ws.close(code, reason);
    },
  } as WebSocketLike;
  ws.onopen = (event) => wrapped.onopen?.(event);
  ws.onclose = (event) => wrapped.onclose?.(event);
  ws.onerror = (event) => wrapped.onerror?.(event);
  ws.onmessage = (event) => {
    logWire('in', event.data);
    wrapped.onmessage?.({ data: event.data });
  };
  return wrapped;
}

const client = new LiveClient({ url: location.origin, WebSocket: observedSocket });

// ---- connection status ----
const dot = el<HTMLSpanElement>('status-dot');
const statusText = el<HTMLSpanElement>('status-text');
const showStatus = (status: string): void => {
  dot.className = status;
  statusText.textContent = status;
};
client.onConnectionStatus(showStatus);

// ---- live todos ----
const list = el<HTMLUListElement>('todos');
function renderTodos(todos: Todo[] | undefined): void {
  list.replaceChildren(
    ...(todos ?? []).map((todo) => {
      const item = document.createElement('li');
      if (todo.optimistic) item.className = 'optimistic';
      const text = document.createElement('span');
      text.textContent = todo.text;
      const remove = document.createElement('button');
      remove.textContent = '✕';
      remove.onclick = () => void client.mutate(`/todos/${todo.id}`, undefined, { method: 'DELETE' });
      item.append(text, remove);
      return item;
    }),
  );
}
client.subscribe('todos.list', {}, (value) => renderTodos(value as Todo[]));

// ---- optimistic add ----
const form = el<HTMLFormElement>('add-form');
const input = el<HTMLInputElement>('add-input');
form.onsubmit = (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  void client.mutate('/todos', { text }, {
    optimistic: {
      query: 'todos.list',
      args: {},
      apply: (todos) => [...(((todos as Todo[]) ?? [])), { id: `tmp-${Date.now()}`, text, optimistic: true }],
    },
  });
};

// ---- simulated network blip ----
// Closing the raw socket (NOT client.close()) looks like a network drop: the
// client reconnects with its cursor+epoch. On the Durable Object transport an
// untouched subscription then gets a tiny `resume` frame — watch the wire.
el<HTMLButtonElement>('blip').onclick = () => activeSocket?.close(4000, 'simulated blip');

// ---- presence ----
const NAMES = ['ada', 'grace', 'edsger', 'barbara', 'alan', 'margaret', 'linus', 'radia'];
const name = `${NAMES[Math.floor(Math.random() * NAMES.length)]}-${Math.floor(Math.random() * 90 + 10)}`;
const presenceLine = el<HTMLDivElement>('presence');
createPresence(client, {
  room: 'default',
  meta: { name },
  onRoster: (members) => {
    const names = members.map((m) => ((m.meta as { name?: string }) ?? {}).name ?? m.id.slice(0, 6));
    presenceLine.textContent = `presence (${members.length}): ${names.join(', ')} — you are ${name}`;
  },
});
