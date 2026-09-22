/* eslint-disable no-await-in-loop -- Pipes and exception filters preserve declared pipeline order. */
import { codeForStatus, toErrorBody, VelaError } from '@velajs/errors';
import {
  buildHttpExecutionContext,
  createDiscoverableDecorator,
  getRequestContainer,
  HttpException,
  PipelineRunner,
  resolveErrorReporter,
  resolvePipelineComponents,
  resolveScopedComponentsAsync,
  shouldFilterCatch,
} from '@velajs/vela';
import type {
  AdapterContext,
  ExceptionFilter,
  HttpExecutionContext,
  RuntimeAdapter,
  Token,
  Type,
  VelaContext,
} from '@velajs/vela';
import {
  isValidationSchema,
  parseSchemaAsync,
  SchemaValidationError,
} from '@velajs/vela/validation';
import type { AnyProcedure, ProcedureInput, ProcedureResult } from './contract';
import { assertJson, isProcedureName, parseRpcRequest, RpcProtocolError } from './protocol';
import type { RpcFailure, RpcRequest } from './protocol';

const metadata = createDiscoverableDecorator<AnyProcedure>('vela:rpc:procedure');
/** Only annotated methods on registered providers are remotely callable. */
export function Rpc<P extends AnyProcedure>(procedure: P) {
  return <
    Handler extends (
      input: NoInfer<ProcedureInput<P>>,
    ) => NoInfer<ProcedureResult<P>> | Promise<NoInfer<ProcedureResult<P>>>,
  >(
    target: object,
    method: string | symbol,
    descriptor: TypedPropertyDescriptor<Handler>,
  ): void => {
    if (typeof descriptor.value !== 'function') throw new TypeError('@Rpc requires a method');
    metadata(procedure)(target, method, descriptor);
  };
}

export interface RpcExecutionContext extends HttpExecutionContext {
  readonly procedure: AnyProcedure;
  readonly callId: string;
}
export interface RpcAdapterOptions {
  /** Full absolute route path; include any desired global prefix explicitly. */
  path?: string;
  /** Explicit exposure policy, in addition to the application's global and method guards. */
  authorize: 'public' | ((context: RpcExecutionContext) => boolean | Promise<boolean>);
}
interface Entry {
  procedure: AnyProcedure;
  token: Token;
  metatype: Type;
  moduleId: string;
  method: string | symbol;
}

/** Adapter instances contain configuration only; each application owns its own registry. */
export function rpcAdapter(options: RpcAdapterOptions): RuntimeAdapter {
  const path = options.path ?? '/rpc';
  // Separate boundary/separator checks from the character scan to avoid
  // ambiguous segment repetition and backtracking on long invalid paths.
  if (
    !path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('//') ||
    /[^A-Za-z0-9_/-]/.test(path)
  )
    throw new TypeError('RPC path must be a concrete absolute path without a trailing slash');
  const authorize = options.authorize;
  if (authorize !== 'public' && typeof authorize !== 'function')
    throw new TypeError('RPC requires an explicit authorize policy');
  return {
    name: 'rpc',
    onRoutesBuilt(context) {
      const app = context.app.getHonoApp();
      if (
        app.routes.some(
          (route) => route.path === path && (route.method === 'POST' || route.method === 'ALL'),
        )
      )
        throw new Error(`RPC route conflicts with existing route '${path}'`);
      const registry = new RpcRegistry(
        {
          discovery: context.discovery,
          getGlobalComponents: () => context.routeManager.getGlobalComponents(),
        },
        authorize,
      );
      app.post(path, (c) => registry.handle(c));
    },
  };
}

interface RpcRegistryContext {
  discovery: AdapterContext['discovery'];
  getGlobalComponents: AdapterContext['routeManager']['getGlobalComponents'];
}

export class RpcRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #app: RpcRegistryContext;
  readonly #authorize: RpcAdapterOptions['authorize'];
  constructor(context: RpcRegistryContext, authorize: RpcAdapterOptions['authorize']) {
    this.#app = context;
    this.#authorize = authorize;
    for (const found of context.discovery.registeredMethodsWithMeta(metadata, {
      metadataOnly: true,
    })) {
      const procedure = found.meta;
      if (
        !isProcedureName(procedure.name) ||
        !isValidationSchema(procedure.input) ||
        !isValidationSchema(procedure.output)
      )
        throw new TypeError('Invalid RPC procedure contract');
      if (this.#entries.has(procedure.name))
        throw new Error(`Duplicate RPC procedure '${procedure.name}'`);
      this.#entries.set(procedure.name, {
        procedure,
        token: found.class.token,
        metatype: found.class.metatype,
        moduleId: found.class.moduleId,
        method: found.methodName,
      });
    }
  }

  async handle(c: VelaContext): Promise<Response> {
    const scope = getRequestContainer(c);
    const reporter = resolveErrorReporter(scope);
    let rpc: RpcRequest;
    try {
      if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
        throw new RpcProtocolError('RPC requires application/json');
      rpc = parseRpcRequest(await c.req.json<unknown>());
    } catch {
      // No trustworthy correlation identity exists for a malformed request.
      return c.json({ error: { code: 'bad_request', message: 'Malformed RPC request' } }, 400);
    }
    const entry = this.#entries.get(rpc.procedure);
    if (!entry) return failure(rpc, new VelaError('not_found'));
    const context: RpcExecutionContext = {
      ...buildHttpExecutionContext(c, entry.metatype, entry.method, entry.moduleId),
      procedure: entry.procedure,
      callId: rpc.id,
    };
    let filters: ExceptionFilter[] = [];
    try {
      const globals = this.#app.getGlobalComponents();
      filters = [
        ...(
          await resolveScopedComponentsAsync(
            'filter',
            entry.metatype,
            entry.method,
            scope,
            entry.moduleId,
          )
        ).toReversed(),
        ...(await resolvePipelineComponents('filter', globals.filters, scope)),
      ];
      const guards = [
        { canActivate: () => this.#authorize === 'public' || this.#authorize(context) },
        ...(await resolvePipelineComponents('guard', globals.guards, scope)),
        ...(await resolveScopedComponentsAsync(
          'guard',
          entry.metatype,
          entry.method,
          scope,
          entry.moduleId,
        )),
      ];
      const pipes = [
        ...(await resolvePipelineComponents('pipe', globals.pipes, scope)),
        ...(await resolveScopedComponentsAsync(
          'pipe',
          entry.metatype,
          entry.method,
          scope,
          entry.moduleId,
        )),
      ];
      const interceptors = [
        ...(await resolvePipelineComponents('interceptor', globals.interceptors, scope)),
        ...(await resolveScopedComponentsAsync(
          'interceptor',
          entry.metatype,
          entry.method,
          scope,
          entry.moduleId,
        )),
      ];
      const result = await PipelineRunner.run({
        context,
        guards,
        interceptors,
        resolveArgs: async () => {
          c.req.raw.signal.throwIfAborted();
          let input: unknown = rpc.input;
          for (const pipe of pipes) {
            input = await (pipe.transformAsync
              ? pipe.transformAsync(input, { type: 'custom' })
              : pipe.transform(input, { type: 'custom' }));
          }
          try {
            return [await parseSchemaAsync(entry.procedure.input, input)];
          } catch (error) {
            if (error instanceof SchemaValidationError)
              throw new VelaError('bad_request', { message: 'RPC input validation failed' });
            throw error;
          }
        },
        invoke: async (args) => {
          c.req.raw.signal.throwIfAborted();
          const instance = await scope.resolveAsync(entry.token, entry.moduleId);
          if (!instance || typeof instance !== 'object')
            throw new TypeError('RPC provider did not resolve to an object');
          const handler: unknown = Reflect.get(instance, entry.method);
          if (typeof handler !== 'function') throw new TypeError('RPC handler is not a method');
          return Reflect.apply(handler, instance, args);
        },
      });
      // Output validation covers short circuits and interceptor replacements too.
      const output: unknown = await parseSchemaAsync(entry.procedure.output, result);
      assertJson(output);
      return c.json({ version: 1, id: rpc.id, procedure: rpc.procedure, ok: true, result: output });
    } catch (error) {
      reporter.report(error, { edge: 'http', source: rpc.procedure, rpcId: rpc.id });
      for (const filter of filters) {
        if (!shouldFilterCatch(filter, error)) continue;
        try {
          // eslint-disable-next-line promise/valid-params -- This is the Vela ExceptionFilter method.
          const filtered = await filter.catch(error, context);
          // Filters retain HTTP terminal semantics, but cannot turn a denial
          // into RPC success. Their status is preserved inside a failure frame.
          if (filtered instanceof Response) {
            void filtered.body?.cancel().catch(() => {});
            return failure(
              rpc,
              new HttpException(
                'RPC request failed',
                filtered.status >= 400 ? filtered.status : 500,
              ),
            );
          }
        } catch (filterError) {
          reporter.report(filterError, {
            edge: 'http',
            source: rpc.procedure,
            note: 'RPC exception filter threw',
          });
        }
        break;
      }
      const rendered = reporter.render(error, context);
      if (rendered instanceof Response) {
        void rendered.body?.cancel().catch(() => {});
        return failure(
          rpc,
          new HttpException('RPC request failed', rendered.status >= 400 ? rendered.status : 500),
        );
      }
      if (rendered)
        return failure(
          rpc,
          new HttpException('RPC request failed', rendered.status >= 400 ? rendered.status : 500),
        );
      return failure(rpc, error, reporter.catalog);
    }
  }
}

function failure(
  rpc: Pick<RpcRequest, 'id' | 'procedure'>,
  error: unknown,
  catalog?: ReturnType<typeof resolveErrorReporter>['catalog'],
): Response {
  const options = catalog ? { catalog } : {};
  let mapped;
  if (error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500) {
    // Only a 4xx is a client fault whose text is meant for the caller.
    const status = error.getStatus();
    const raw = error.getRawResponse();
    mapped = toErrorBody(
      new VelaError(codeForStatus(status), {
        message: typeof raw === 'string' ? raw : 'RPC request failed',
        status,
      }),
      options,
    );
  } else
    mapped = toErrorBody(error, {
      ...options,
      ...(error instanceof HttpException ? { fallbackStatus: error.getStatus() } : {}),
    });
  const status = mapped.status >= 400 && mapped.status <= 599 ? mapped.status : 500;
  const code = /^[A-Za-z0-9_.:-]{1,160}$/.test(mapped.body.error.code)
    ? mapped.body.error.code
    : 'internal';
  const message =
    code === 'internal' ? 'Internal Server Error' : mapped.body.error.message.slice(0, 2048);
  const response: RpcFailure = {
    version: 1,
    id: rpc.id,
    procedure: rpc.procedure,
    ok: false,
    error: { code, message, status },
  };
  return Response.json(response, { status });
}
