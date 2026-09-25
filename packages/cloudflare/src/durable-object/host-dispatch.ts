/* eslint-disable no-await-in-loop -- Pipes and exception filters keep their declared order. */
import { getErrorStatus } from '@velajs/vela';
import type {
  ErrorReportContext,
  ExceptionFilter,
  Type,
  VelaApplicationContext,
} from '@velajs/vela';
import {
  PipelineRunner,
  buildEntrypointExecutionContext,
  createExecutionScope,
  getMetadata,
  resolveErrorReporter,
  resolveScopedComponentsAsync,
  shouldFilterCatch,
  trackResponseStream,
  type Container,
  type EntrypointExecutionContext,
  type ErrorReporter,
  type ExecutionScope,
} from '@velajs/vela/module-kit';
import type { CloudflareRoot } from '../root-module';
import {
  DurableObjectError,
  renderDurableObjectError,
  renderDurableObjectResponse,
} from './durable-object-error';
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

interface Failure {
  readonly filters: readonly ExceptionFilter[];
  readonly context: DurableObjectExecutionContext;
  readonly reporter: ErrorReporter;
  readonly report: ErrorReportContext;
}

/** How an invocation's result is sent after its handler returned. */
interface Transmission<T> {
  /** What the invocation returns in place of the handler's result. */
  readonly value: T;
  /** Settles once the result was sent, failed or was cancelled. */
  readonly sent: Promise<unknown>;
  /** Finish the scope after the invocation returns, rather than before. */
  readonly background: boolean;
}

/** How one kind of invocation ends: its result, and what a failure becomes. */
interface Settlement<T> {
  success(value: unknown): T;
  failure(error: unknown, failure: Failure): Promise<T>;
  /** Managed work that fails after a successful handler fails the invocation. */
  readonly completionFails?: boolean;
}

/** The first scoped filter (closest first) that catches `error`. */
function claimingFilter(
  filters: readonly ExceptionFilter[],
  error: unknown,
): ExceptionFilter | undefined {
  return filters.find((filter) => shouldFilterCatch(filter, error));
}

/** A filter that throws replaces the error; its own throw is reported too. */
async function catchWith(
  filter: ExceptionFilter,
  error: unknown,
  { context, reporter, report }: Failure,
): Promise<{ handled: true; value: unknown } | { handled: false; error: unknown }> {
  try {
    // eslint-disable-next-line promise/valid-params -- The Vela ExceptionFilter hook.
    return { handled: true, value: await filter.catch(error, context) };
  } catch (replacement) {
    if (replacement !== error) {
      reporter.report(replacement, { ...report, note: 'exception filter threw' });
    }
    return { handled: false, error: replacement };
  }
}

const rpc: Settlement<unknown> = {
  success: (value) => value,
  async failure(error, failure) {
    const filter = claimingFilter(failure.filters, error);
    let current = error;
    if (filter) {
      const caught = await catchWith(filter, error, failure);
      // A filter may recover with a result; returning nothing keeps the failure.
      if (caught.handled && caught.value !== undefined) return caught.value;
      if (!caught.handled) current = caught.error;
    }
    throw renderDurableObjectError(current, failure.reporter, failure.context);
  },
};

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
    return renderDurableObjectResponse(current, failure.reporter, failure.context);
  },
};

/** Platform events: a claiming filter handles the failure; otherwise the platform sees it. */
function platformSettlement(completionFails: boolean): Settlement<void> {
  return {
    completionFails,
    success: () => undefined,
    async failure(error, failure) {
      const filter = claimingFilter(failure.filters, error);
      if (!filter) throw error;
      const caught = await catchWith(filter, error, failure);
      if (!caught.handled) throw caught.error;
    },
  };
}

// Alarms are retried by the platform: managed work that fails fails the alarm too.
const alarmSettlement = platformSettlement(true);
const webSocketSettlement = platformSettlement(false);

/** The one failure a caller learns of an error the pipeline never rendered. */
const internalFailure = (): DurableObjectError =>
  new DurableObjectError({ status: 500, code: 'internal', message: 'Internal Server Error' });

/** Report through the application, or the console when its reporter cannot be built. */
function reportOutside(container: Container, error: unknown, report: ErrorReportContext): void {
  try {
    resolveErrorReporter(container).report(error, report);
  } catch {
    console.error(`[vela] ${report.edge} error in ${report.source ?? 'a Durable Object'}:`, error);
  }
}

/**
 * Runs the invocations of one Durable Object instance's host: each RPC call
 * and event in a fresh execution scope (request-scoped providers are built
 * per invocation) through the host's scoped guards, pipes (RPC arguments
 * only), interceptors and exception filters. Application-wide `APP_*`
 * components do not apply: an object's callers are other Workers and the
 * platform, with no HTTP request. Failures are reported first; an RPC call
 * rejects with a {@link DurableObjectError}, a `fetch()` renders a JSON error
 * response, and alarms and WebSocket events rethrow for the platform.
 */
export class DurableObjectHostDispatcher {
  readonly context: VelaApplicationContext;
  readonly #host: Type;
  readonly #moduleId: string | undefined;
  readonly #methods: ReadonlySet<string>;
  readonly #waitUntil: ((promise: Promise<unknown>) => void) | undefined;

  constructor(
    context: VelaApplicationContext,
    host: Type,
    moduleId: string | undefined,
    members: DurableObjectHostMembers,
    waitUntil?: (promise: Promise<unknown>) => void,
  ) {
    this.context = context;
    this.#host = host;
    this.#moduleId = moduleId;
    this.#methods = new Set(members.methods);
    this.#waitUntil = waitUntil;
  }

  /**
   * Call the host's RPC method `method`. It rejects only with a
   * {@link DurableObjectError}, also when the invocation fails before its
   * pipeline renders the error.
   */
  async call(method: string, args: readonly unknown[]): Promise<unknown> {
    if (!this.#methods.has(method)) {
      throw new DurableObjectError({
        status: 404,
        code: 'not_found',
        message: 'Unknown Durable Object method',
      });
    }
    try {
      return await this.#invoke('rpc', method, args, rpc);
    } catch (error) {
      if (error instanceof DurableObjectError) throw error;
      reportOutside(this.context.getContainer(), error, this.#report('rpc', method));
      throw internalFailure();
    }
  }

  /**
   * Serve the host's `fetch()`; any failure becomes a JSON error response. A
   * streamed body keeps the invocation's scope (its request-scoped providers
   * and managed work) open until it is sent.
   */
  async fetch(request: Request): Promise<Response> {
    try {
      return await this.#invoke('cf:do:fetch', 'fetch', [request], fetchSettlement, (response) =>
        this.#transmit(request, response),
      );
    } catch (error) {
      reportOutside(this.context.getContainer(), error, this.#report('cf:do:fetch', 'fetch'));
      const failure = internalFailure();
      return Response.json(
        { error: { code: failure.code, message: failure.message } },
        { status: failure.status },
      );
    }
  }

  #report(kind: DurableObjectInvocationKind, method: string): ErrorReportContext {
    return { edge: 'durable-object', source: `${this.#host.name}.${method}`, kind };
  }

  alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#invoke('cf:do:alarm', 'alarm', info === undefined ? [] : [info], alarmSettlement);
  }

  webSocket(handler: DurableObjectWebSocketHandler, args: readonly unknown[]): Promise<void> {
    return this.#invoke('cf:do:websocket', handler, args, webSocketSettlement);
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

  async #invoke<T>(
    kind: DurableObjectInvocationKind,
    method: string,
    args: readonly unknown[],
    settlement: Settlement<T>,
    transmit?: (value: T) => Transmission<T> | undefined,
  ): Promise<T> {
    const root = this.context.getContainer();
    const report = this.#report(kind, method);
    const scope = createExecutionScope(root);
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = {
        ok: true,
        value: await this.#run(scope.container, kind, method, args, settlement, report),
      };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const transmission = outcome.ok ? transmit?.(outcome.value) : undefined;
    if (transmission?.background) {
      // The scope outlives the invocation until its body is sent.
      this.#finishLater(scope, transmission.sent, report);
      return transmission.value;
    }
    try {
      // Request-scoped providers and managed work (`EXECUTION_LIFETIME`)
      // settle before the invocation does.
      await scope.finish(transmission?.sent);
    } catch (completion) {
      reportOutside(root, completion, {
        ...report,
        note: 'managed work failed after the invocation',
      });
      if (settlement.completionFails && outcome.ok) outcome = { ok: false, error: completion };
    }
    if (!outcome.ok) throw outcome.error;
    return transmission ? transmission.value : outcome.value;
  }

  /** Finish `scope` after `boundary` settles, reporting a failure; the object waits for it. */
  #finishLater(
    scope: ExecutionScope,
    boundary: Promise<unknown>,
    report: ErrorReportContext,
  ): void {
    const completion = scope.finish(boundary).catch((error: unknown) => {
      reportOutside(this.context.getContainer(), error, {
        ...report,
        note: 'managed work failed after the response',
      });
    });
    this.#waitUntil?.(completion);
  }

  async #run<T>(
    scope: Container,
    kind: DurableObjectInvocationKind,
    method: string,
    args: readonly unknown[],
    settlement: Settlement<T>,
    report: ErrorReportContext,
  ): Promise<T> {
    const host = this.#host;
    const moduleId = this.#moduleId;
    const context = buildEntrypointExecutionContext(kind, host, method, args, moduleId, scope);
    const reporter = resolveErrorReporter(scope);
    let filters: ExceptionFilter[] = [];
    try {
      filters = (
        await resolveScopedComponentsAsync('filter', host, method, scope, moduleId)
      ).toReversed();
      const guards = await resolveScopedComponentsAsync('guard', host, method, scope, moduleId);
      const interceptors = await resolveScopedComponentsAsync(
        'interceptor',
        host,
        method,
        scope,
        moduleId,
      );
      const value = await PipelineRunner.run({
        context,
        guards,
        interceptors,
        resolveArgs: () =>
          kind === 'rpc'
            ? this.#transformArguments(scope, method, args)
            : Promise.resolve([...args]),
        invoke: async (resolved) => {
          const instance: unknown = await scope.resolveAsync(host, moduleId);
          if (typeof instance !== 'object' || instance === null) {
            throw new TypeError(`${host.name} did not resolve to an object.`);
          }
          const handler: unknown = Reflect.get(instance, method);
          if (typeof handler !== 'function') {
            throw new TypeError(`${host.name}.${method} is not a method.`);
          }
          return Reflect.apply(handler, instance, resolved);
        },
      });
      return settlement.success(value);
    } catch (error) {
      reporter.report(error, report);
      return settlement.failure(error, { filters, context, reporter, report });
    }
  }

  /** Scoped pipes transform each RPC argument, typed by the method's parameter metadata. */
  async #transformArguments(
    scope: Container,
    method: string,
    args: readonly unknown[],
  ): Promise<unknown[]> {
    const pipes = await resolveScopedComponentsAsync(
      'pipe',
      this.#host,
      method,
      scope,
      this.#moduleId,
    );
    if (pipes.length === 0) return [...args];
    const types = getMetadata<unknown[]>('design:paramtypes', this.#host.prototype, method);
    const transformed: unknown[] = [];
    for (const [index, argument] of args.entries()) {
      const metadata = { type: 'custom', metatype: types?.[index] };
      let value = argument;
      for (const pipe of pipes) {
        value = await (pipe.transformAsync
          ? pipe.transformAsync(value, metadata)
          : pipe.transform(value, metadata));
      }
      transformed.push(value);
    }
    return transformed;
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
  const container = context.getContainer();
  const rootClass = typeof root === 'function' ? root : root.module;
  const owners = container.getOwnerModuleIds(host);
  const moduleId =
    owners.find((owner) => container.getModuleScope(owner)?.moduleClass === rootClass) ?? owners[0];
  return new DurableObjectHostDispatcher(context, host, moduleId, members, options.waitUntil);
}
