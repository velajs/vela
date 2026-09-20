import { createAuthClient } from 'better-auth/client';
import { createLiveClient } from '@velajs/client';
import { hc } from '@velajs/client/http';
import { createPresence } from '@velajs/client/presence';
import { queries, type Todo } from '../src/contracts';
import type { AppType } from './api.generated';

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Missing element: ${id}`);
  return found;
}
const auth = createAuthClient({ baseURL: location.origin });
const api = hc<AppType>(location.origin);
const errorLine = element('error', HTMLDivElement);
const status = element('status', HTMLSpanElement);
let disconnect: (() => void) | undefined;
async function run(action: () => Promise<void>) {
  errorLine.textContent = '';
  try { await action(); } catch (error) { errorLine.textContent = error instanceof Error ? error.message : String(error); }
}
async function accepted(response: Response) {
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${await response.text()}`);
}
function render(todos: Todo[] | undefined) {
  element('todos', HTMLUListElement).replaceChildren(...(todos ?? []).map(todo => {
    const row = document.createElement('li');
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = todo.done; toggle.ariaLabel = `Complete ${todo.title}`;
    toggle.onchange = () => void run(async () => {
      await accepted(await api.todos[':id'].$patch({ param: { id: todo.id }, json: { done: toggle.checked } }));
    });
    const text = document.createElement('span'); text.textContent = todo.title; text.className = todo.done ? 'done' : '';
    const remove = document.createElement('button'); remove.textContent = 'Delete';
    remove.onclick = () => void run(async () => { await accepted(await api.todos[':id'].$delete({ param: { id: todo.id } })); });
    row.append(toggle, text, remove); return row;
  }));
}
async function refreshSession() {
  disconnect?.(); disconnect = undefined;
  const response = await api.me.$get();
  const signedIn = response.ok;
  element('auth', HTMLElement).hidden = signedIn;
  element('board', HTMLElement).hidden = !signedIn;
  if (!signedIn) { status.textContent = 'Signed out'; render([]); return; }
  const user = await response.json();
  element('user', HTMLSpanElement).textContent = user.name;
  const live = createLiveClient({ url: location.origin, queries });
  live.onConnectionStatus(value => { status.textContent = value; });
  live.subscribe('todos.list', {}, render);
  const presence = createPresence(live, { room: 'default', meta: { name: user.name }, onRoster: members => {
    element('presence', HTMLParagraphElement).textContent = `${members.length} connected tab${members.length === 1 ? '' : 's'}`;
  } });
  disconnect = () => { presence.stop(); live.close(); };
}
element('auth-form', HTMLFormElement).onsubmit = event => {
  event.preventDefault();
  void run(async () => {
    const email = element('email', HTMLInputElement).value;
    const password = element('password', HTMLInputElement).value;
    const mode = event.submitter instanceof HTMLButtonElement ? event.submitter.value : 'sign-in';
    const result = mode === 'sign-up'
      ? await auth.signUp.email({ email, password, name: element('name', HTMLInputElement).value || email.split('@')[0] || 'User' })
      : await auth.signIn.email({ email, password });
    if (result.error) throw new Error(result.error.message ?? 'Authentication failed');
    await refreshSession();
  });
};
element('sign-out', HTMLButtonElement).onclick = () => void run(async () => { await auth.signOut(); await refreshSession(); });
element('add-form', HTMLFormElement).onsubmit = event => {
  event.preventDefault();
  void run(async () => {
    const input = element('title', HTMLInputElement);
    await accepted(await api.todos.$post({ json: { title: input.value.trim(), done: false } }));
    input.value = '';
  });
};
void run(refreshSession);
