import { createLiveClient } from '@velajs/client';
import type { WebSocketLike } from '@velajs/client';
import { createPresence } from '@velajs/client/presence';
import { isClientLiveFrame, isServerLiveFrame, readLiveEnvelope } from '@velajs/live-protocol';
import { todoListDefinition } from '../src/live-contract';
import type { Todo } from '../src/live-contract';

function el<T extends HTMLElement>(id: string, elementType: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof elementType)) throw new Error(`Missing ${elementType.name}: ${id}`);
  return element;
}
const wirePanel = el('wire', HTMLDivElement);

function logWire(direction: 'out' | 'in', raw: unknown): void {
  if (typeof raw !== 'string') return;
  try {
    const envelope: unknown = JSON.parse(raw);
    const frame = readLiveEnvelope(envelope);
    if (!isClientLiveFrame(frame) && !isServerLiveFrame(frame)) return;
    const cursor = 'cursor' in frame ? frame.cursor : undefined;
    const epoch = 'epoch' in frame ? frame.epoch : undefined;
    const line = document.createElement('div');
    line.className = direction;
    const stamp = cursor !== undefined ? `  cursor=${cursor} epoch=${(epoch ?? '').slice(0, 8)}` : '';
    line.textContent = `${direction === 'out' ? '→' : '←'} ${frame.t}${stamp}`;
    wirePanel.appendChild(line);
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
  };
  ws.onopen = (event) => wrapped.onopen?.(event);
  ws.onclose = (event) => wrapped.onclose?.(event);
  ws.onerror = (event) => wrapped.onerror?.(event);
  ws.onmessage = (event) => {
    logWire('in', event.data);
    wrapped.onmessage?.({ data: event.data });
  };
  return wrapped;
}

const client = createLiveClient({
  url: location.origin,
  WebSocket: observedSocket,
  queries: { 'todos.list': todoListDefinition },
});

// ---- connection status ----
const dot = el('status-dot', HTMLSpanElement);
const statusText = el('status-text', HTMLSpanElement);
const showStatus = (status: string): void => {
  dot.className = status;
  statusText.textContent = status;
};
client.onConnectionStatus(showStatus);

// ---- live todos ----
const list = el('todos', HTMLUListElement);
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
      item.appendChild(text);
      item.appendChild(remove);
      return item;
    }),
  );
}
client.subscribe('todos.list', {}, renderTodos);

// ---- optimistic add ----
const form = el('add-form', HTMLFormElement);
const input = el('add-input', HTMLInputElement);
form.onsubmit = (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  void client.mutate('/todos', { text }, {
    optimistic: {
      query: 'todos.list',
      args: {},
      apply: (todos) => [
        ...todoListDefinition.result.parse(todos ?? []),
        { id: `tmp-${Date.now()}`, text, createdAt: Date.now(), optimistic: true },
      ],
    },
  });
};

// ---- simulated network blip ----
// Closing the raw socket (NOT client.close()) looks like a network drop: the
// client reconnects with its cursor+epoch. On the Durable Object transport an
// untouched subscription then gets a tiny `resume` frame — watch the wire.
el('blip', HTMLButtonElement).onclick = () => activeSocket?.close(4000, 'simulated blip');

// ---- presence ----
const NAMES = ['ada', 'grace', 'edsger', 'barbara', 'alan', 'margaret', 'linus', 'radia'];
const name = `${NAMES[Math.floor(Math.random() * NAMES.length)]}-${Math.floor(Math.random() * 90 + 10)}`;
const presenceLine = el('presence', HTMLDivElement);
createPresence(client, {
  room: 'default',
  meta: { name },
  onRoster: (members) => {
    const names = members.map((m) => {
      const meta = m.meta;
      return typeof meta === 'object' && meta !== null && 'name' in meta && typeof meta.name === 'string'
        ? meta.name
        : m.id.slice(0, 6);
    });
    presenceLine.textContent = `presence (${members.length}): ${names.join(', ')} — you are ${name}`;
  },
});
