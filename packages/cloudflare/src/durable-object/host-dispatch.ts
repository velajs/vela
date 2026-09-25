import { getErrorStatus } from '@velajs/vela';
import type { Type, VelaApplicationContext } from '@velajs/vela';
import { trackResponseStream, type EntrypointExecutionContext } from '@velajs/vela/module-kit';
import type { CloudflareRoot } from '../root-module';
import {
  HostInvoker,
  callRpcMethod,
  catchWith,
  claimingFilter,
  hostModuleId,
  platformSettlement,
  type Settlement,
  type Transmission,
} from '../host/host-invoker';
import { internalEntrypointError, renderEntrypointResponse } from '../rpc/entrypoint-error';
import {
  createDurableObjectContext,
  withDurableObjectHost,
  type DurableObjectContextOptions,
} from './boot';
import type { DurableObjectHostMembers } from './host-methods';

/**
 * The `ExecutionContext.getType()` of a Durable Object invocation: `rpc` for
 * a host method called over RPC, `cf:do:fetch`, `cf:do:alarm` and
 * `cf:do:websocket` for the object's event handlers. `getPayload()` is the
 * invocation's arguments.
 */
export type DurableObjectInvocationKind = 'rpc' | 'cf:do:fetch' | 'cf:do:alarm' | 'cf:do:websocket';

/** The ExecutionContext guards, interceptors and filters receive around a Durable Object invocation. */
export type DurableObjectExecutionContext = EntrypointExecutionContext<DurableObjectInvocationKind>;

/** A WebSocket hibernation handler a host implements. */
export type DurableObjectWebSocketHandler =
  | 'webSocketMessage'
  | 'webSocketClose'
  | 'webSocketError';

const fetchSettlement: Settlement<Response> = {
  success(value) {
    if (!(value instanceof Response)) {
      throw new TypeError('A Durable Object host fetch() must return a Response.');
    }
    return value;
  },
  async failure(error, failure) {
    const filter = claimingFilter(failure.filters, error);
    let current = error;
    if (filter) {
      const caught = await catchWith(filter, error, failure);
      if (caught.handled) {
        if (caught.value instanceof Response) return caught.value;
        if (caught.value !== undefined) {
          return Response.json(caught.value, { status: getErrorStatus(error) });
        }
      } else {
        current = caught.error;
      }
    }
    return renderEntrypointResponse(current, failure.reporter, failure.context);
  },
};

// Alarms are retried by the platform: managed work that fails fails the alarm too.
const alarmSettlement = platformSettlement(true);
const webSocketSettlement = platformSettlement(false);

/**
 * Runs the invocations of one Durable Object instance's host: each RPC call
 * and event in a fresh execution scope (request-scoped providers are built
 * per invocation) through the host's scoped guards, pipes (RPC arguments
 * only), interceptors and exception filters. Application-wide `APP_*`
 * components do not apply: an object's callers are other Workers and the
 * platform, with no HTTP request. Failures are reported first; an RPC call
 * rejects with an `EntrypointError`, a `fetch()` renders a JSON error
 * response, and alarms and WebSocket events rethrow for the platform.
 */
export class DurableObjectHostDispatcher {
  readonly context: VelaApplicationContext;
  readonly #invoker: HostInvoker;
  readonly #methods: ReadonlySet<string>;

  constructor(
    context: VelaApplicationContext,
    host: Type,
    moduleId: string | undefined,
    members: DurableObjectHostMembers,
    waitUntil?: (promise: Promise<unknown>) => void,
  ) {
    this.context = context;
    this.#invoker = new HostInvoker({
      container: context.getContainer(),
      host,
      moduleId,
      edge: 'durable-object',
      waitUntil,
    });
    this.#methods = new Set(members.methods);
  }

  /**
   * Call the host's RPC method `method`. It rejects only with an
   * `EntrypointError`, also when the invocation fails before its pipeline
   * renders the error.
   */
  call(method: string, args: readonly unknown[]): Promise<unknown> {
    return callRpcMethod(this.#invoker, this.#methods, method, args);
  }

  /**
   * Serve the host's `fetch()`; any failure becomes a JSON error response. A
   * streamed body keeps the invocation's scope (its request-scoped providers
   * and managed work) open until it is sent.
   */
  async fetch(request: Request): Promise<Response> {
    try {
      return await this.#invoker.invoke({
        kind: 'cf:do:fetch',
        method: 'fetch',
        args: [request],
        settlement: fetchSettlement,
        transmit: (response) => this.#transmit(request, response),
      });
    } catch (error) {
      this.#invoker.reportOutside(error, this.#invoker.report('cf:do:fetch', 'fetch'));
      const failure = internalEntrypointError();
      return Response.json(
        { error: { code: failure.code, message: failure.message } },
        { status: failure.status },
      );
    }
  }

  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    await this.#invoker.invoke({
      kind: 'cf:do:alarm',
      method: 'alarm',
      args: info === undefined ? [] : [info],
      settlement: alarmSettlement,
    });
  }

  async webSocket(handler: DurableObjectWebSocketHandler, args: readonly unknown[]): Promise<void> {
    await this.#invoker.invoke({
      kind: 'cf:do:websocket',
      method: handler,
      args,
      settlement: webSocketSettlement,
    });
  }

  /**
   * How a `fetch()` response is sent: a streamed body keeps the scope open
   * until it was read, failed or was cancelled, and the object's `waitUntil`
   * holds that completion. A HEAD response sends no body, so its body is
   * cancelled before the scope finishes. A WebSocket upgrade (101) and a
   * bodyless response need nothing.
   */
  #transmit(request: Request, response: Response): Transmission<Response> | undefined {
    if (response.body === null || response.status === 101) return undefined;
    if (request.method === 'HEAD') {
      return {
        value: new Response(null, response),
        sent: response.body.cancel(),
        background: false,
      };
    }
    const stream = trackResponseStream(response.body);
    return { value: new Response(stream.body, response), sent: stream.done, background: true };
  }
}

/** @internal Options of {@link createDurableObjectHost}. */
export interface DurableObjectHostOptions extends DurableObjectContextOptions {
  /** Keeps the object alive for work that outlives an invocation, such as a streamed body. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Boot one Durable Object instance's application context from `root` with
 * `host` added to the root module's providers, and return its dispatcher,
 * which serves `members`.
 */
export async function createDurableObjectHost(
  root: CloudflareRoot,
  host: Type,
  options: DurableObjectHostOptions,
  members: DurableObjectHostMembers,
): Promise<DurableObjectHostDispatcher> {
  const context = await createDurableObjectContext(withDurableObjectHost(root, host), options);
  const rootClass = typeof root === 'function' ? root : root.module;
  const moduleId = hostModuleId(context.getContainer(), host, rootClass);
  return new DurableObjectHostDispatcher(context, host, moduleId, members, options.waitUntil);
}
