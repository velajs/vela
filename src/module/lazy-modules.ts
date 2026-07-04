import { Scope } from '../constants';
import type { Container } from '../container/container';
import type { LazyResolutionHook, Token } from '../container/types';
import {
  hasOnApplicationBootstrap,
  hasOnModuleInit,
} from '../lifecycle/index';

/** One lazy module instance's deferral unit: its own tokens, in registration order. */
export interface LazyModuleGroup {
  moduleId: string;
  tokens: Token[];
  /**
   * A class provider's prototype declares `collectEntrypoints` — the module
   * must be materialized before the entrypoint registry snapshot or its
   * computed contributions would be silently absent.
   */
  hasEntrypointContributor: boolean;
}

function isThenable(x: unknown): x is PromiseLike<unknown> {
  return (
    x !== null &&
    (typeof x === 'object' || typeof x === 'function') &&
    typeof (x as PromiseLike<unknown>).then === 'function'
  );
}

/**
 * Owns deferred-module state for one application: which module instances are
 * still pending, which have been claimed by a container trigger, and how
 * claimed groups get completed (construction + lifecycle-hook replay).
 *
 * Phases:
 * - `'bootstrap'` (until the end of `callOnApplicationBootstrap`): completed
 *   groups are *absorbed* — their instances queue up for the application's
 *   normal hook phases, so a lazy module dragged in by an eager consumer gets
 *   today-identical semantics.
 * - `'live'`: hooks replay at drain time (memoized, exactly once), then the
 *   instances are handed to the application for shutdown-hook symmetry.
 *
 * Sync/async duality: sync drains throw a descriptive error when a member
 * factory or hook yields a thenable — lazy modules with async providers or
 * hooks must be reached through an async seam (`materializeLazyModules()`,
 * `resolveAsync`) or stay eager.
 */
export class LazyModuleManager implements LazyResolutionHook {
  private readonly pending = new Map<string, LazyModuleGroup>();
  private readonly claimed: LazyModuleGroup[] = [];
  private readonly absorbed: unknown[] = [];
  private phase: 'bootstrap' | 'live' = 'bootstrap';
  private draining = false;
  // In-flight async drain: concurrent drainAsync callers must await the SAME
  // completion (the running loop picks their claims up), never resolve early
  // with a group's hooks still pending.
  private drainPromise?: Promise<void>;
  private onMaterialized?: (instances: unknown[]) => void;

  constructor(private readonly container: Container) {}

  registerGroup(group: LazyModuleGroup): void {
    this.pending.set(group.moduleId, group);
  }

  /** Application sink for live-phase materializations (shutdown symmetry). */
  setOnMaterialized(sink: (instances: unknown[]) => void): void {
    this.onMaterialized = sink;
  }

  setPhaseLive(): void {
    this.phase = 'live';
  }

  isPending(moduleId: string): boolean {
    return this.pending.has(moduleId);
  }

  /** Tokens whose owning modules are ALL still pending are deferred. */
  hasPendingModules(): boolean {
    return this.pending.size > 0;
  }

  claim(moduleId: string): void {
    const group = this.pending.get(moduleId);
    if (!group) return;
    this.pending.delete(moduleId);
    this.claimed.push(group);
  }

  hasClaimed(): boolean {
    return this.claimed.length > 0;
  }

  /**
   * A drain loop is running. The container consults this before its
   * post-resolution drain: `constructGroupAsync` resolves members through
   * `resolveAsync`, whose end-of-cascade check would otherwise re-enter and
   * AWAIT the very drain promise it is executing inside — a self-referential
   * await that never settles (with ≥2 claimed groups). Claims made while
   * draining are picked up by the running loop instead.
   */
  isDraining(): boolean {
    return this.draining;
  }

  /** Instances constructed during the bootstrap phase, owed their hooks. */
  takeAbsorbed(): unknown[] {
    if (this.absorbed.length === 0) return [];
    return this.absorbed.splice(0, this.absorbed.length);
  }

  drainSync(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      // Construct-all-then-hook, batch by batch: a cascade's groups arrive in
      // consumer-before-dependency claim order (the consumer's token resolves
      // first; constructing it claims its deps), so hook phases run over the
      // REVERSED batch — dependency-before-consumer, matching what the eager
      // bootstrap would have produced. Hooks can claim further groups
      // (discovery cascades) → outer loop.
      while (this.claimed.length > 0) {
        const batch: Array<{ group: LazyModuleGroup; instances: unknown[] }> = [];
        while (this.claimed.length > 0) {
          const group = this.claimed.shift()!;
          batch.push({ group, instances: this.constructGroupSync(group) });
        }
        this.finishBatchSync(batch);
      }
    } finally {
      this.draining = false;
    }
  }

  drainAsync(): Promise<void> {
    if (this.draining) {
      // External concurrent callers await the in-flight completion (its loop
      // picks their claims up). Callers INSIDE the drain's own await chain
      // never reach here — the container skips its post-resolution drain
      // while isDraining() (self-await would deadlock).
      return this.drainPromise ?? Promise.resolve();
    }
    this.draining = true;
    const run = (async () => {
      try {
        while (this.claimed.length > 0) {
          const batch: Array<{ group: LazyModuleGroup; instances: unknown[] }> = [];
          while (this.claimed.length > 0) {
            const group = this.claimed.shift()!;
            batch.push({ group, instances: await this.constructGroupAsync(group) });
          }
          await this.finishBatchAsync(batch);
        }
      } finally {
        this.draining = false;
        this.drainPromise = undefined;
      }
    })();
    this.drainPromise = run;
    return run;
  }

  /**
   * Materialize every still-pending group whose providers compute entrypoints
   * (`collectEntrypoints` on a class prototype). Called by the application
   * right before the entrypoint-registry snapshot so computed contributions
   * are never silently absent. The cost — those modules are effectively
   * eager — is the documented price of contributing computed entrypoints.
   */
  async materializeContributors(): Promise<void> {
    for (const group of [...this.pending.values()]) {
      if (group.hasEntrypointContributor) this.claim(group.moduleId);
    }
    await this.drainAsync();
  }

  /** Materialize everything still pending (warmup / tests / node runtimes). */
  async materializeAll(): Promise<void> {
    for (const moduleId of [...this.pending.keys()]) this.claim(moduleId);
    await this.drainAsync();
  }

  private groupTokensToConstruct(group: LazyModuleGroup): Token[] {
    return group.tokens.filter(
      (token) => this.container.getProviderScope(token) !== Scope.REQUEST,
    );
  }

  private constructGroupSync(group: LazyModuleGroup): unknown[] {
    const out = new Set<unknown>();
    for (const token of this.groupTokensToConstruct(group)) {
      try {
        out.add(this.container.resolve(token, group.moduleId));
      } catch (error) {
        // Only the sync-resolution-of-async-factory error is a seam problem;
        // genuine provider failures must surface untouched.
        if (error instanceof Error && error.message.includes('returned a Promise')) {
          throw this.describeSyncFailure(group.moduleId, error);
        }
        throw error;
      }
    }
    return [...out];
  }

  private async constructGroupAsync(group: LazyModuleGroup): Promise<unknown[]> {
    const out = new Set<unknown>();
    for (const token of this.groupTokensToConstruct(group)) {
      out.add(await this.container.resolveAsync(token, group.moduleId));
    }
    return [...out];
  }

  /** Reversed batch = dependency-before-consumer (see drainSync comment). */
  private orderBatch(
    batch: Array<{ group: LazyModuleGroup; instances: unknown[] }>,
  ): Array<{ group: LazyModuleGroup; instances: unknown[] }> {
    return [...batch].reverse();
  }

  private finishBatchSync(batch: Array<{ group: LazyModuleGroup; instances: unknown[] }>): void {
    const ordered = this.orderBatch(batch);
    if (this.phase === 'bootstrap') {
      for (const { instances } of ordered) this.absorbed.push(...instances);
      return;
    }
    for (const { group, instances } of ordered) {
      for (const instance of instances) {
        if (hasOnModuleInit(instance) && isThenable(instance.onModuleInit())) {
          throw this.describeSyncFailure(group.moduleId);
        }
      }
    }
    for (const { group, instances } of ordered) {
      for (const instance of instances) {
        if (hasOnApplicationBootstrap(instance) && isThenable(instance.onApplicationBootstrap())) {
          throw this.describeSyncFailure(group.moduleId);
        }
      }
    }
    this.onMaterialized?.(ordered.flatMap((b) => b.instances));
  }

  private async finishBatchAsync(
    batch: Array<{ group: LazyModuleGroup; instances: unknown[] }>,
  ): Promise<void> {
    const ordered = this.orderBatch(batch);
    if (this.phase === 'bootstrap') {
      for (const { instances } of ordered) this.absorbed.push(...instances);
      return;
    }
    for (const { instances } of ordered) {
      for (const instance of instances) {
        if (hasOnModuleInit(instance)) await instance.onModuleInit();
      }
    }
    for (const { instances } of ordered) {
      for (const instance of instances) {
        if (hasOnApplicationBootstrap(instance)) await instance.onApplicationBootstrap();
      }
    }
    this.onMaterialized?.(ordered.flatMap((b) => b.instances));
  }

  private describeSyncFailure(moduleId: string, cause?: unknown): Error {
    return new Error(
      `[vela] lazy module '${moduleId}' has async providers or lifecycle hooks and was ` +
        `triggered through a synchronous resolution path. Reach it through an async seam ` +
        `first (app.materializeLazyModules(), an async provider) or remove lazy: true.`,
      cause !== undefined ? { cause } : undefined,
    );
  }
}
