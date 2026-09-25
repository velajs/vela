/**
 * `StudioDispatchRegistry` — builds the op→handler map at bootstrap and runs
 * the security-gated dispatch for `POST {p}/rpc/:op`.
 *
 * Bootstrap (OnApplicationBootstrap): scan the application's
 * `DiscoveryService.registeredMethodsWithMeta(AdminRpc)`,
 * THROW on an op not in `STUDIO_OPS` (unless allowed via `STUDIO_TEST_ONLY_OPS`)
 * or a duplicate op.
 *
 * Dispatch: unknown op → 404; write-mode ops whose gate is closed → 403
 * (`DATA_EDIT_DISABLED` for the data gate, else `STUDIO_OP_FORBIDDEN`);
 * destructive ops without a valid `confirmToken` → 428; success →
 * `{ ok, op, data, meta }`; thrown errors → redacted `AdminErrorBody`. Handler
 * providers are resolved PER CALL (lazy-safe), mirroring the queue dispatcher.
 */
import { Inject, Injectable } from '@velajs/vela';
import { APP_LOGGER } from '@velajs/vela/logging';
import {
  DiscoveryService,
  getRequestContainer,
  runInEntrypointScope,
  resolveErrorReporter,
} from '@velajs/vela/module-kit';
import type { OnApplicationBootstrap, Token, Type } from '@velajs/vela';
import type { Container, ErrorReporter } from '@velajs/vela/module-kit';
import { STUDIO_OP_META, STUDIO_OPS } from '@velajs/studio-protocol';
import type { AdminRpcRequest, AdminRpcResponse, StudioOp } from '@velajs/studio-protocol';
import { AdminConfirmSummary, AdminRpc } from './admin-rpc.decorator';
import { deriveWriteGates } from '../studio.types';
import type {
  AdminAuditDetail,
  AdminConfirmSummaryMeta,
  AdminOpContext,
  AdminRpcMeta,
  StudioConfirmChallenge,
} from '../studio.types';
import { studioError, toAdminErrorBody } from '../studio.errors';
import { ConfirmTokenSigner } from '../security/confirm-token';
import { AdminAuditLog } from '../audit/audit-log';
import { STUDIO_APPLICATION_CONTAINER, STUDIO_TEST_ONLY_OPS } from '../tokens';

interface HandlerEntry {
  token: Type;
  methodName: string | symbol;
  moduleId: string;
}

/** Default meta for ops absent from the frozen catalog (test-only ops). */
const DEFAULT_OP_META = { mode: 'read', feature: 'app' } as const;

@Injectable()
export class StudioDispatchRegistry implements OnApplicationBootstrap {
  private readonly handlers = new Map<string, HandlerEntry>();
  /** op → the `@AdminConfirmSummary` method that supplies its challenge summary. */
  private readonly summarizers = new Map<string, HandlerEntry>();

  constructor(
    @Inject(STUDIO_APPLICATION_CONTAINER) private readonly container: Container,
    @Inject(ConfirmTokenSigner) private readonly confirm: ConfirmTokenSigner,
    @Inject(AdminAuditLog) private readonly auditLog: AdminAuditLog,
  ) {}

  onApplicationBootstrap(): void {
    const allowed = new Set<string>(STUDIO_OPS as readonly string[]);
    for (const extra of this.testOnlyOps()) allowed.add(extra);
    // The application's discovery, as app.get(DiscoveryService) returns it.
    const discovery = this.container.has(DiscoveryService)
      ? this.container.resolve(DiscoveryService)
      : new DiscoveryService(this.container);

    for (const found of discovery.registeredMethodsWithMeta<AdminRpcMeta>(AdminRpc, {
      metadataOnly: true,
    })) {
      const { op } = found.meta;
      if (!allowed.has(op)) {
        throw new Error(
          `@AdminRpc: '${op}' on ${found.class.metatype.name}.${String(found.methodName)} is not a ` +
            `known Studio op. Use a name from STUDIO_OPS (or add it to STUDIO_TEST_ONLY_OPS in tests).`,
        );
      }
      if (this.handlers.has(op)) {
        const prior = this.handlers.get(op)!;
        throw new Error(
          `@AdminRpc: duplicate handler for op '${op}' — ${prior.token.name}.${String(prior.methodName)} and ` +
            `${found.class.metatype.name}.${String(found.methodName)}. Each op maps to exactly one handler.`,
        );
      }
      this.handlers.set(op, {
        token: found.class.metatype,
        methodName: found.methodName,
        moduleId: found.class.moduleId,
      });
    }

    for (const found of discovery.registeredMethodsWithMeta<AdminConfirmSummaryMeta>(
      AdminConfirmSummary,
      { metadataOnly: true },
    )) {
      if (this.summarizers.has(found.meta.op)) {
        throw new Error(`@AdminConfirmSummary: duplicate summary for op '${found.meta.op}'.`);
      }
      this.summarizers.set(found.meta.op, {
        token: found.class.metatype,
        methodName: found.methodName,
        moduleId: found.class.moduleId,
      });
    }
  }

  /** True iff `op` has a registered handler. */
  has(op: string): boolean {
    return this.handlers.has(op);
  }

  /** Registered op names (introspection / tests). */
  registeredOps(): string[] {
    return [...this.handlers.keys()];
  }

  /** Run the full gated dispatch for `op`. Never throws — errors become the error branch. */
  async dispatch(op: string, req: AdminRpcRequest, ctx: AdminOpContext): Promise<AdminRpcResponse> {
    const start = Date.now();
    const meta = (STUDIO_OP_META as Record<string, AdminRpcMetaLike>)[op] ?? DEFAULT_OP_META;
    let detail: AdminAuditDetail | undefined;
    let reporter: ErrorReporter | undefined;
    const handlerCtx: AdminOpContext = {
      ...ctx,
      audit: (d) => {
        detail = d;
      },
    };

    try {
      if (this.container.has(APP_LOGGER)) reporter = resolveErrorReporter(this.container);
      const entry = this.handlers.get(op);
      if (!entry) throw studioError('STUDIO_UNKNOWN_OP');

      this.enforceGate(meta, ctx);
      const data = await this.withScope(ctx, async (scope) => {
        // Capture before disposal so completion errors retain inert correlation.
        if (scope.has(APP_LOGGER)) reporter = resolveErrorReporter(scope);
        await this.enforceConfirm(op, meta, req, handlerCtx, scope);
        return this.invoke(scope, entry, handlerCtx, req.args);
      });

      const ms = Date.now() - start;
      this.recordAudit(op, meta.mode, ctx, 200, ms, detail);
      return { ok: true, op, data, meta: { ms, op, mode: meta.mode } };
    } catch (error) {
      reporter?.report(error, { edge: 'rpc', source: `studio.${op}` });
      const { body, status } = toAdminErrorBody(error);
      const ms = Date.now() - start;
      this.recordAudit(op, meta.mode, ctx, status, ms, detail);
      return { ok: false, op, error: body, status };
    }
  }

  private withScope<T>(ctx: AdminOpContext, run: (scope: Container) => Promise<T>): Promise<T> {
    let requestScope: Container | undefined;
    try {
      requestScope = getRequestContainer(ctx.http);
    } catch {
      // Contributor-mounted routes may have no framework request child.
    }
    return requestScope === undefined
      ? runInEntrypointScope(this.container, run, { signal: ctx.http.req.raw.signal })
      : run(requestScope);
  }

  private async invoke(
    scope: Container,
    entry: HandlerEntry,
    ctx: AdminOpContext,
    args: unknown,
  ): Promise<unknown> {
    const instance = await scope.resolveAsync(entry.token, entry.moduleId);
    if ((typeof instance !== 'object' || instance === null) && typeof instance !== 'function') {
      throw studioError('STUDIO_UNKNOWN_OP');
    }
    const method: unknown = Reflect.get(instance, entry.methodName, instance);
    if (typeof method !== 'function') throw studioError('STUDIO_UNKNOWN_OP');
    const ownedContext: AdminOpContext = {
      ...ctx,
      get: (token) => scope.resolve(token, entry.moduleId),
    };
    return Reflect.apply(method, instance, [ownedContext, args]);
  }

  private enforceGate(meta: AdminRpcMetaLike, ctx: AdminOpContext): void {
    if (meta.mode !== 'write' || !meta.gate) return;
    const gates = deriveWriteGates(ctx.editable);
    if (!gates[meta.gate]) {
      throw meta.gate === 'dataEditable'
        ? studioError('DATA_EDIT_DISABLED')
        : studioError('STUDIO_OP_FORBIDDEN');
    }
  }

  /**
   * The 428 challenge-response gate for destructive ops. A valid, unspent
   * `confirmToken` bound to (op, payload-minus-token) is consumed (single-use)
   * and the op proceeds. Otherwise a fresh token is minted BOUND to the same
   * (op, payload) and thrown as `STUDIO_CONFIRM_REQUIRED` (428) whose
   * `error.details = { confirmToken, expiresAt, summary }` — the summary
   * supplied by the op's `@AdminConfirmSummary` provider. Generic: any op
   * flagged `destructive` in `STUDIO_OP_META` gets this flow.
   *
   * The binding is over the ENTIRE payload (args minus `confirmToken`), so a
   * preview token minted without `force`/`scope` will NOT verify against an arm
   * that adds them (the payload hash differs) — the caller gets a fresh 428
   * challenge for the widened request. That re-challenge is CORRECT: `force`
   * (override a schema mismatch) and `scope` change what the destructive op does,
   * so the operator must re-confirm the summary for the actual action.
   */
  private async enforceConfirm(
    op: string,
    meta: AdminRpcMetaLike,
    req: AdminRpcRequest,
    ctx: AdminOpContext,
    scope: Container,
  ): Promise<void> {
    if (!meta.destructive) return;
    const args = (req.args ?? {}) as Record<string, unknown>;
    const { confirmToken, ...payload } = args;
    if (
      typeof confirmToken === 'string' &&
      confirmToken.length > 0 &&
      (await this.confirm.verifyAndConsume(op, payload, confirmToken))
    ) {
      return;
    }
    const { token, exp } = await this.confirm.issue(op, payload);
    const details: StudioConfirmChallenge = {
      confirmToken: token,
      expiresAt: exp * 1000,
      summary: await this.summarize(op, ctx, payload, scope),
    };
    throw studioError('STUDIO_CONFIRM_REQUIRED', undefined, details);
  }

  /** Resolve the op's confirm-summary provider, or a generic fallback line. */
  private async summarize(
    op: string,
    ctx: AdminOpContext,
    payload: Record<string, unknown>,
    scope: Container,
  ): Promise<string> {
    const entry = this.summarizers.get(op);
    if (entry === undefined) return `Confirm ${op}`;
    const summary = await this.invoke(scope, entry, ctx, payload);
    if (typeof summary !== 'string')
      throw new TypeError('Studio confirm summary must be a string.');
    return summary;
  }

  private recordAudit(
    op: string,
    mode: 'read' | 'write',
    ctx: AdminOpContext,
    status: number,
    ms: number,
    detail: AdminAuditDetail | undefined,
  ): void {
    this.auditLog.record({
      ts: Date.now(),
      op,
      mode,
      subject: ctx.admin.subject,
      status,
      ms,
      ip: ctx.admin.ip,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  private testOnlyOps(): readonly string[] {
    return this.container.has(STUDIO_TEST_ONLY_OPS as Token)
      ? this.container.resolve(STUDIO_TEST_ONLY_OPS)
      : [];
  }
}

/** Structural view of a `STUDIO_OP_META` entry (avoids importing the const's literal type). */
interface AdminRpcMetaLike {
  mode: 'read' | 'write';
  feature: string;
  gate?: keyof ReturnType<typeof deriveWriteGates>;
  destructive?: true;
}

export type { StudioOp };
