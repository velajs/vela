/* eslint-disable no-await-in-loop -- Pipes and exception filters keep their declared order. */
import type { ErrorReportContext, ExceptionFilter, Type } from '@velajs/vela';
import {
  PipelineRunner,
  buildEntrypointExecutionContext,
  createExecutionScope,
  getEntrypointModuleId,
  getMetadata,
  resolveErrorReporter,
  resolveScopedComponentsAsync,
  shouldFilterCatch,
  type Container,
  type Entrypoint,
  type EntrypointExecutionContext,
  type ErrorReporter,
  type ExecutionScope,
} from '@velajs/vela/module-kit';
import {
  EntrypointError,
  internalEntrypointError,
  renderEntrypointError,
} from '../rpc/entrypoint-error';

/** What a failed invocation hands its settlement, after the failure was reported. */
export interface InvocationFailure {
  readonly filters: readonly ExceptionFilter[];
  readonly context: EntrypointExecutionContext;
  readonly reporter: ErrorReporter;
  readonly report: ErrorReportContext;
}

/** How an invocation's result is sent after its handler returned. */
export interface Transmission<T> {
  /** What the invocation returns in place of the handler's result. */
  readonly value: T;
  /** Settles once the result was sent, failed or was cancelled. */
  readonly sent: Promise<unknown>;
  /** Finish the scope after the invocation returns, rather than before. */
  readonly background: boolean;
}

/** How one kind of invocation ends: its result, and what a failure becomes. */
export interface Settlement<T> {
  success(value: unknown): T;
  failure(error: unknown, failure: InvocationFailure): Promise<T>;
  /** Managed work that fails after a successful handler fails the invocation. */
  readonly completionFails?: boolean;
}

/** The first scoped filter (closest first) that catches `error`. */
export function claimingFilter(
  filters: readonly ExceptionFilter[],
  error: unknown,
): ExceptionFilter | undefined {
  return filters.find((filter) => shouldFilterCatch(filter, error));
}

/** A filter that throws replaces the error; its own throw is reported too. */
export async function catchWith(
  filter: ExceptionFilter,
  error: unknown,
  { context, reporter, report }: InvocationFailure,
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

/**
 * A JS-RPC call: a claiming filter may recover with a result (returning
 * nothing keeps the failure); otherwise the call rejects with the rendered
 * {@link EntrypointError}.
 */
export const rpcSettlement: Settlement<unknown> = {
  success: (value) => value,
  async failure(error, failure) {
    const filter = claimingFilter(failure.filters, error);
    let current = error;
    if (filter) {
      const caught = await catchWith(filter, error, failure);
      if (caught.handled && caught.value !== undefined) return caught.value;
      if (!caught.handled) current = caught.error;
    }
    throw renderEntrypointError(current, failure.reporter, failure.context);
  },
};

/**
 * A platform event: a claiming filter handles the failure (a value it returns
 * becomes the result); otherwise the platform sees the error.
 */
export function platformSettlement(completionFails: boolean): Settlement<unknown> {
  return {
    completionFails,
    success: (value) => value,
    async failure(error, failure) {
      const filter = claimingFilter(failure.filters, error);
      if (!filter) throw error;
      const caught = await catchWith(filter, error, failure);
      if (!caught.handled) throw caught.error;
      return caught.value;
    },
  };
}

/**
 * An event whose failures must never reach the platform, such as a tail
 * event: the failure was reported, and a claiming filter still runs.
 */
export const observedSettlement: Settlement<void> = {
  success: () => undefined,
  async failure(error, failure) {
    const filter = claimingFilter(failure.filters, error);
    if (filter) await catchWith(filter, error, failure);
  },
};

/** One invocation of a host method. */
export interface HostInvocation<T> {
  /** `ExecutionContext.getType()`: `'rpc'`, `'cf:workflow'`, ... */
  readonly kind: string;
  readonly method: string | symbol;
  readonly args: readonly unknown[];
  /** `ExecutionContext.getPayload()`; the arguments by default. */
  readonly payload?: unknown;
  readonly settlement: Settlement<T>;
  /** Transform each argument through the scoped pipes (RPC arguments). */
  readonly pipes?: boolean;
  /** Seed request-scoped values, such as the caller's props, into the invocation scope. */
  readonly seed?: (scope: Container) => void;
  /** How a successful result is sent, such as a streamed response body. */
  readonly transmit?: (value: T) => Transmission<T> | undefined;
  /**
   * Whether `error` is the platform steering the invocation rather than a
   * failure of it, such as the Workflows engine pausing a run: it is rethrown
   * as it is, never reported or handed to an exception filter.
   */
  readonly passthrough?: (error: unknown) => boolean;
}

/** What a {@link HostInvoker} runs its invocations against. */
export interface HostInvokerOptions {
  /** The application container each invocation scope is a child of. */
  readonly container: Container;
  /** The class whose method each invocation calls, resolved in the invocation scope. */
  readonly host: Type;
  /** The module the host is resolved in, and its scoped components. */
  readonly moduleId: string | undefined;
  /** The `ErrorReportContext.edge` failures are reported on. */
  readonly edge: ErrorReportContext['edge'];
  /** Keeps the platform object alive for work that outlives an invocation. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Runs invocations of one host's methods: each in a fresh execution scope
 * (request-scoped providers are built per invocation) through the host's
 * scoped guards, pipes (when asked), interceptors and exception filters.
 * Application-wide `APP_*` components do not apply: the callers are other
 * Workers and the platform, with no HTTP request. Failures are reported
 * first, then settled the way the invocation's kind requires.
 */
export class HostInvoker {
  readonly #container: Container;
  readonly #host: Type;
  readonly #moduleId: string | undefined;
  readonly #edge: ErrorReportContext['edge'];
  readonly #waitUntil: ((promise: Promise<unknown>) => void) | undefined;

  constructor(options: HostInvokerOptions) {
    this.#container = options.container;
    this.#host = options.host;
    this.#moduleId = options.moduleId;
    this.#edge = options.edge;
    this.#waitUntil = options.waitUntil;
  }

  /** The report context of an invocation of `method`. */
  report(kind: string, method: string | symbol): ErrorReportContext {
    return { edge: this.#edge, source: `${this.#host.name}.${String(method)}`, kind };
  }

  /** Report through the application, or the console when its reporter cannot be built. */
  reportOutside(error: unknown, report: ErrorReportContext): void {
    try {
      resolveErrorReporter(this.#container).report(error, report);
    } catch {
      console.error(`[vela] ${report.edge} error in ${report.source ?? 'an entrypoint'}:`, error);
    }
  }

  async invoke<T>(invocation: HostInvocation<T>): Promise<T> {
    const root = this.#container;
    const report = this.report(invocation.kind, invocation.method);
    const scope = createExecutionScope(root);
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      invocation.seed?.(scope.container);
      outcome = { ok: true, value: await this.#run(scope.container, invocation, report) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    let transmission: Transmission<T> | undefined;
    try {
      transmission = outcome.ok ? invocation.transmit?.(outcome.value) : undefined;
    } catch (error) {
      // Such as a body another reader locked: the scope still finishes.
      outcome = { ok: false, error };
    }
    if (transmission?.background) {
      // The scope outlives the invocation until its result is sent.
      this.#finishLater(scope, transmission.sent, report);
      return transmission.value;
    }
    try {
      // Request-scoped providers and managed work (`EXECUTION_LIFETIME`)
      // settle before the invocation does.
      await scope.finish(transmission?.sent);
    } catch (completion) {
      this.reportOutside(completion, {
        ...report,
        note: 'managed work failed after the invocation',
      });
      if (invocation.settlement.completionFails && outcome.ok) {
        outcome = { ok: false, error: completion };
      }
    }
    if (!outcome.ok) throw outcome.error;
    return transmission ? transmission.value : outcome.value;
  }

  /** Finish `scope` after `boundary` settles, reporting a failure; the platform waits for it. */
  #finishLater(
    scope: ExecutionScope,
    boundary: Promise<unknown>,
    report: ErrorReportContext,
  ): void {
    const completion = scope.finish(boundary).catch((error: unknown) => {
      this.reportOutside(error, { ...report, note: 'managed work failed after the response' });
    });
    this.#waitUntil?.(completion);
  }

  async #run<T>(
    scope: Container,
    invocation: HostInvocation<T>,
    report: ErrorReportContext,
  ): Promise<T> {
    const host = this.#host;
    const moduleId = this.#moduleId;
    const { kind, method, args, settlement } = invocation;
    const context = buildEntrypointExecutionContext(
      kind,
      host,
      method,
      'payload' in invocation ? invocation.payload : args,
      moduleId,
      scope,
    );
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
          invocation.pipes
            ? this.#transformArguments(scope, method, args)
            : Promise.resolve([...args]),
        invoke: async (resolved) => {
          const instance: unknown = await scope.resolveAsync(host, moduleId);
          if (typeof instance !== 'object' || instance === null) {
            throw new TypeError(`${host.name} did not resolve to an object.`);
          }
          const handler: unknown = Reflect.get(instance, method);
          if (typeof handler !== 'function') {
            throw new TypeError(`${host.name}.${String(method)} is not a method.`);
          }
          return Reflect.apply(handler, instance, resolved);
        },
      });
      return settlement.success(value);
    } catch (error) {
      if (invocation.passthrough?.(error) === true) throw error;
      reporter.report(error, report);
      return settlement.failure(error, { filters, context, reporter, report });
    }
  }

  /** Scoped pipes transform each argument, typed by the method's parameter metadata. */
  async #transformArguments(
    scope: Container,
    method: string | symbol,
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

/**
 * Call the RPC method `method` of a host through `invoker`. It rejects only
 * with an {@link EntrypointError}: a method `methods` does not list answers
 * `404 not_found`, and a failure outside the pipeline is reported and becomes
 * `500 internal`.
 */
export async function callRpcMethod(
  invoker: HostInvoker,
  methods: ReadonlySet<string>,
  method: string,
  args: readonly unknown[],
  seed?: (scope: Container) => void,
): Promise<unknown> {
  if (!methods.has(method)) {
    throw new EntrypointError({ status: 404, code: 'not_found', message: 'Unknown RPC method' });
  }
  try {
    return await invoker.invoke({
      kind: 'rpc',
      method,
      args,
      settlement: rpcSettlement,
      pipes: true,
      seed,
    });
  } catch (error) {
    if (error instanceof EntrypointError) throw error;
    invoker.reportOutside(error, invoker.report('rpc', method));
    throw internalEntrypointError();
  }
}

/**
 * An invoker of a decorated method entrypoint (`@OnEmail()`, `@OnTail()`):
 * its class, resolved in the module that registered it.
 */
export function entrypointInvoker(
  container: Container,
  entrypoint: Entrypoint,
  edge: ErrorReportContext['edge'],
): HostInvoker {
  const { token } = entrypoint;
  if (typeof token !== 'function') throw new TypeError('Entrypoint token must be a class.');
  return new HostInvoker({
    container,
    host: token,
    moduleId: getEntrypointModuleId(container, entrypoint),
    edge,
  });
}

/** Wait for every invocation, even when one fails before its siblings; then fail with them. */
export async function settleInvocations(work: readonly Promise<unknown>[]): Promise<void> {
  const outcomes = await Promise.allSettled(work);
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Multiple entrypoint handlers failed.');
}

/**
 * The module a host added to the root module's providers is resolved in: the
 * root's registration when there are several.
 */
export function hostModuleId(
  container: Container,
  host: Type,
  rootClass: Type,
): string | undefined {
  const owners = container.getOwnerModuleIds(host);
  return (
    owners.find((owner) => container.getModuleScope(owner)?.moduleClass === rootClass) ?? owners[0]
  );
}
