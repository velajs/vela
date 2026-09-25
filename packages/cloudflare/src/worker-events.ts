import type { VelaEnv } from '@velajs/vela';
import type { CloudflareApplication } from './cloudflare-application';

/** Worker handlers a feature subpath adds to every Worker when a module imports it. */
export type WorkerEventName = 'email' | 'tail';

/**
 * @internal Deliver one platform event to the application built for its
 * environment: `application` returns it, built on first use (it rejects when
 * the application fails to start, and the next event retries), `payload` is
 * the handler's first argument (the email message, the tail events), `ctx`
 * the platform's execution context.
 */
export type WorkerEventDispatcher = (
  application: () => Promise<CloudflareApplication>,
  payload: unknown,
  ctx: ExecutionContext | undefined,
) => Promise<void>;

type ApplicationCache = (env: VelaEnv) => Promise<CloudflareApplication>;

/** How many optional events there are: `email` and `tail`. */
const EVENTS = 2;

const dispatchers = new Map<WorkerEventName, WorkerEventDispatcher>();
/** Each Worker's per-environment cache, while the Worker lives. */
const applications = new WeakMap<object, ApplicationCache>();
/**
 * Workers defined before every event's module loaded: they get its handler
 * when it does. workerd has no `WeakRef`, so they are held until then; a
 * Worker entry defines one Worker, at module scope.
 */
const pending = new Set<object>();

/** Give `worker` the `name` handler, delivered by `dispatch`, unless its object already has one. */
function defineHandler(
  worker: object,
  name: WorkerEventName,
  dispatch: WorkerEventDispatcher,
): void {
  const application = applications.get(worker);
  if (application === undefined || Object.hasOwn(worker, name)) return;
  Object.defineProperty(worker, name, {
    enumerable: true,
    configurable: true,
    writable: true,
    value: async (payload: unknown, env: VelaEnv, ctx?: ExecutionContext): Promise<void> =>
      dispatch(() => application(env), payload, ctx),
  });
}

/**
 * @internal Give every Worker the `name` handler, delivered by `dispatcher`.
 * The decorator modules of `@velajs/cloudflare/email` and
 * `@velajs/cloudflare/tail` call it when they load, so a Worker has the
 * handler exactly when its code declares such handlers.
 */
export function registerWorkerEvent(
  name: WorkerEventName,
  dispatcher: WorkerEventDispatcher,
): void {
  dispatchers.set(name, dispatcher);
  for (const worker of pending) defineHandler(worker, name, dispatcher);
  if (dispatchers.size === EVENTS) pending.clear();
}

/**
 * @internal Define the optional handlers of a Worker's exported object: one
 * for each event a loaded module handles, and later ones as their modules
 * load. An event no loaded module handles gets no handler, so the platform
 * sees none. `application` is the Worker's per-environment cache.
 */
export function defineWorkerEvents(worker: object, application: ApplicationCache): void {
  applications.set(worker, application);
  for (const [name, dispatcher] of dispatchers) defineHandler(worker, name, dispatcher);
  if (dispatchers.size < EVENTS) pending.add(worker);
}
