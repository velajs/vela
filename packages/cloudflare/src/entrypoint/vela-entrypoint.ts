import { WorkerEntrypoint } from 'cloudflare:workers';
import { InjectionToken, Scope } from '@velajs/vela';
import type { Type, VelaEnv } from '@velajs/vela';
import type { EntrypointExecutionContext } from '@velajs/vela/module-kit';
import type { CloudflareApplication } from '../cloudflare-application';
import {
  CLOUDFLARE_ENTRYPOINT,
  cloudflareApplication,
  isCloudflareApp,
  registerEntrypoint,
  type CloudflareApp,
  type CloudflareEntrypointDescriptor,
} from '../cloudflare-factory';
import { HostInvoker, callRpcMethod, hostModuleId } from '../host/host-invoker';
import {
  hostMembers,
  type RpcMethodOf,
  type RpcMethods,
  type RpcSurface,
} from '../host/host-members';
import { internalEntrypointError } from '../rpc/entrypoint-error';

/**
 * The `props` of the current service entrypoint call (`ctx.props` in a
 * hand-written `WorkerEntrypoint`): what the caller's service binding
 * configuration (`services: [{ binding, service, entrypoint, props }]`) or a
 * `ctx.exports` loopback stub attached. Request-scoped: it resolves only
 * inside an RPC call of a `VelaEntrypoint()` class, and a class injecting it
 * is built for each call. Validate it before use; it is `{}` when the caller
 * attached none.
 */
export const ENTRYPOINT_PROPS = /* @__PURE__ */ new InjectionToken<unknown>(
  '@velajs/cloudflare:entrypoint-props',
  {
    scope: Scope.REQUEST,
    factory: () => {
      throw new Error(
        'ENTRYPOINT_PROPS can only be resolved inside a service entrypoint RPC call: ' +
          'VelaEntrypoint() seeds it into each call with the caller ctx.props.',
      );
    },
  },
);

/** WorkerEntrypoint handlers the platform calls, never RPC methods. */
const WORKER_ENTRYPOINT_HANDLERS = [
  'fetch',
  'connect',
  'email',
  'queue',
  'scheduled',
  'tail',
  'tailStream',
  'test',
  'trace',
] as const;

/**
 * Names an RPC method cannot take: the entrypoint's own `ctx` and `env`, the
 * platform handlers of a `WorkerEntrypoint`, the stub members that shadow an
 * RPC method of that name (`fetch()`, `connect()`, `dup()`), and `then`,
 * which would make the stub and its results thenables.
 */
const SERVICE_ENTRYPOINT: RpcSurface<never> = {
  label: 'service entrypoint',
  reserved: new Set(['ctx', 'env', 'dup', 'then', ...WORKER_ENTRYPOINT_HANDLERS]),
  handlers: [],
};

/**
 * @internal The RPC methods of `host` its service entrypoint class exposes:
 * the methods `rpc` names. A hook, a reserved name, an accessor or an instance
 * field throws, and so does a host whose prototype defines `then`. Read at
 * class definition, without constructing the host.
 */
export function entrypointHostMembers(
  host: abstract new (...args: never[]) => unknown,
  rpc?: readonly string[],
): { methods: string[] } {
  return { methods: hostMembers(host, rpc, SERVICE_ENTRYPOINT).methods };
}

/** Host members that are never RPC methods, besides hooks: the names {@link SERVICE_ENTRYPOINT} reserves. */
type NotRpcMethod = (typeof WORKER_ENTRYPOINT_HANDLERS)[number] | 'ctx' | 'env' | 'dup' | 'then';

/**
 * The names a service entrypoint host's `rpc` list may take: its public
 * methods, less hooks, platform handlers and names the entrypoint or its
 * stubs own. TypeScript `private` and `protected` methods are not among them.
 */
export type EntrypointRpcMethod<Host> = RpcMethodOf<Host, NotRpcMethod>;

/**
 * The RPC methods a `VelaEntrypoint(app, Host, { rpc })` class exposes: the
 * host methods `Method` names, asynchronous. A service binding to the class
 * (`Service<typeof Billing>`) calls them with these signatures.
 */
export type EntrypointRpc<Host, Method extends EntrypointRpcMethod<Host>> = RpcMethods<
  Host,
  Method
>;

/** Options of {@link VelaEntrypoint}. */
export interface VelaEntrypointOptions<Method extends string = string> {
  /**
   * The host methods callers may invoke over JS-RPC, such as
   * `['charge', 'refund']`: public methods declared in the host's class body
   * (or inherited). Nothing else is an RPC method, so TypeScript `private`
   * helpers, hooks and unlisted methods stay unreachable.
   */
  readonly rpc?: readonly Method[];
}

/**
 * The class `VelaEntrypoint(app, Host, { rpc })` returns: export a named
 * subclass of it, which service bindings name as their `entrypoint`. It also
 * carries its `CloudflareEntrypointDescriptor` under the static
 * `CLOUDFLARE_ENTRYPOINT` key, for tools.
 */
export type VelaEntrypointClass<Host, Method extends EntrypointRpcMethod<Host> = never> = new (
  ctx: ExecutionContext,
  env: VelaEnv,
) => WorkerEntrypoint<VelaEnv> & EntrypointRpc<Host, Method>;

/** The ExecutionContext guards, interceptors and filters receive around a service RPC call. */
export type EntrypointRpcExecutionContext = EntrypointExecutionContext<'rpc'>;

/**
 * A service entrypoint class (a `WorkerEntrypoint`) whose JS-RPC methods are
 * the methods of `host`, an `@Injectable()` class, that `rpc` names. Each call
 * runs in the Worker's application for its environment: the one the app's
 * Worker handlers use, with the host added to the root module's providers.
 * Export a named subclass and bind it from another Worker (or this one) with
 * `services: [{ binding, service, entrypoint: 'Billing' }]`:
 *
 * ```ts
 * @Injectable()
 * export class BillingHost {
 *   constructor(
 *     private readonly invoices: InvoicesService,
 *     @Inject(ENTRYPOINT_PROPS) private readonly props: unknown,
 *   ) {}
 *   async charge(customerId: string, cents: number): Promise<{ invoiceId: string }> {
 *     return this.invoices.charge(customerId, cents);
 *   }
 * }
 * export class Billing extends VelaEntrypoint(app, BillingHost, { rpc: ['charge'] }) {}
 * // Caller: await env.BILLING.charge('customer-1', 500)
 * ```
 *
 * - Exactly the host methods `rpc` names are RPC methods, typed so a
 *   `Service<typeof Billing>` binding exposes their signatures. Nothing else
 *   is reachable over RPC, even from plain JavaScript naming it on a stub. A
 *   listed name that is not a prototype method of the host, a hook, a
 *   `WorkerEntrypoint` handler (`fetch`, `connect`, `email`, `queue`,
 *   `scheduled`, `tail`, ...), `ctx`, `env`, `dup` or `then` throws here, and
 *   so does a host whose prototype defines `then()`.
 * - Each call runs in its own execution scope, so request-scoped providers
 *   are built per call, through the host's scoped guards, pipes (the
 *   arguments), interceptors and filters (`getType()` is `'rpc'`). The
 *   caller's `ctx.props` is injectable as {@link ENTRYPOINT_PROPS}.
 * - Failures are reported (`edge: 'rpc'`); a call rejects only with an
 *   `EntrypointError`, rendered like an HTTP response with server errors
 *   redacted.
 */
export function VelaEntrypoint<
  Host extends object,
  const Method extends EntrypointRpcMethod<Host> = never,
>(
  app: CloudflareApp,
  host: Type<Host>,
  options: VelaEntrypointOptions<Method> = {},
): VelaEntrypointClass<Host, Method> {
  if (!isCloudflareApp(app)) {
    throw new TypeError(
      'VelaEntrypoint() takes the app from defineCloudflareApp(AppModule, options): each call ' +
        'runs in the Worker application that app builds.',
    );
  }
  if (typeof host !== 'function') {
    throw new TypeError('VelaEntrypoint(app, Host, { rpc }) takes the @Injectable() host class.');
  }
  const members = entrypointHostMembers(host, options.rpc);
  const methods: ReadonlySet<string> = new Set(members.methods);
  const rootClass = typeof app.rootModule === 'function' ? app.rootModule : app.rootModule.module;
  const invokers = new WeakMap<CloudflareApplication, HostInvoker>();
  const invokerOf = (application: CloudflareApplication): HostInvoker => {
    const existing = invokers.get(application);
    if (existing) return existing;
    const container = application.getContainer();
    const invoker = new HostInvoker({
      container,
      host,
      moduleId: hostModuleId(container, host, rootClass),
      edge: 'rpc',
    });
    invokers.set(application, invoker);
    return invoker;
  };
  /** The platform's `ctx` and `env` of each instance, readable by the methods defined below. */
  const platform = new WeakMap<object, { ctx: ExecutionContext; env: VelaEnv }>();

  class VelaHostEntrypoint extends WorkerEntrypoint<VelaEnv> {
    constructor(ctx: ExecutionContext, env: VelaEnv) {
      super(ctx, env);
      platform.set(this, { ctx, env });
    }
  }

  const prototype = VelaHostEntrypoint.prototype;
  for (const method of members.methods) {
    Object.defineProperty(prototype, method, {
      writable: true,
      configurable: true,
      value: async function (this: object, ...args: unknown[]): Promise<unknown> {
        const call = platform.get(this);
        let application: CloudflareApplication;
        try {
          if (call === undefined)
            throw new TypeError('Entrypoint method called on a foreign receiver.');
          application = await cloudflareApplication(app, call.env);
        } catch (error) {
          // A caller learns that the application failed to start, never why.
          console.error(`[vela] Service entrypoint ${host.name} failed to start:`, error);
          throw internalEntrypointError();
        }
        const props: unknown = call.ctx.props ?? {};
        return callRpcMethod(invokerOf(application), methods, method, args, (scope) =>
          scope.setRequestInstance(ENTRYPOINT_PROPS, props),
        );
      },
    });
  }

  const descriptor: CloudflareEntrypointDescriptor = {
    rootModule: app.rootModule,
    host,
    methods: members.methods,
    entrypoint: VelaHostEntrypoint,
  };
  registerEntrypoint(app, descriptor);
  Object.defineProperty(VelaHostEntrypoint, 'name', { value: `${host.name}Entrypoint` });
  Object.defineProperty(VelaHostEntrypoint, CLOUDFLARE_ENTRYPOINT, { value: descriptor });
  // The RPC methods are defined on the prototype above, at runtime, from the rpc list.
  return VelaHostEntrypoint as unknown as VelaEntrypointClass<Host, Method>;
}
