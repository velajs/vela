import type { Token } from '../container/types';
import type { DiscoveryService } from '../discovery/discovery.service';

/**
 * A declared entrypoint kind: a named category of non-HTTP (or non-standard)
 * entry surface that some module knows how to dispatch — WebSocket gateways,
 * queue consumers, scheduled jobs, CLI commands. Core ships NO fixed set;
 * any module registers its own kind and any runtime adapter can query it.
 *
 * `metaKey` binds the kind to a decorator's metadata key: every provider
 * carrying that metadata becomes an entrypoint of this kind at bootstrap.
 */
export interface EntrypointKind {
  kind: string;
  metaKey: string;
  /**
   * 'class': one entrypoint per decorated provider (`@WebSocketGateway`).
   * 'method': one entrypoint per decorated method (`@Cron`, `@QueueConsumer`
   * handler methods) — flattened from the class-level list convention.
   */
  level: 'class' | 'method';
}

/** One concrete entrypoint discovered at bootstrap. */
export interface Entrypoint<M = unknown> {
  kind: string;
  token: Token;
  /** Owning registration. Optional only for legacy computed contributors. */
  moduleId?: string;
  /** The resolved provider backing the entrypoint (undefined if request-scoped). */
  instance: unknown;
  /** Present for method-level kinds. */
  methodName?: string | symbol;
  meta: M;
}

/**
 * Escape hatch for providers whose entrypoints are computed rather than purely
 * decorator-declared (e.g. `WsDispatcher` aggregates per-gateway routing state
 * before contributing). Implementers are detected among the app's eagerly
 * instantiated providers after `onApplicationBootstrap` hooks have run.
 */
export interface ContributesEntrypoints {
  collectEntrypoints(discovery: DiscoveryService): Entrypoint[] | Promise<Entrypoint[]>;
}

export function contributesEntrypoints(x: unknown): x is ContributesEntrypoints {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as ContributesEntrypoints).collectEntrypoints === 'function'
  );
}
