/**
 * `@velajs/studio/queue` — the OPTIONAL `@velajs/vela/queue` binding for the
 * queues panel.
 *
 * This subpath is the ONLY module in the package that imports
 * `@velajs/vela/queue`: the core `.` entry never does, so apps without the queue
 * module still mount `StudioModule`. An app WITH queues adds `queuesPanel()` to
 * `StudioModule.forRoot({ plugins })`, which registers {@link StudioQueueOps} — the seam that lights the `queue` feature by
 * op-namespace registration (in UNION with the pre-existing `queue`
 * entrypoint-kind signal the M4 features service already reads).
 *
 * Queues are enumerated from the app's `QueueRegistry` (every
 * `QueueModule.registerQueue` name) in union with the per-app
 * `EntrypointRegistry`'s `queue` kind (every `@Processor`) — the same app-scoped
 * sources the features service uses. Producing goes through the registered
 * queue's `QueueClient` (`queueToken(name)`).
 *
 * HONEST DEGRADATIONS (the in-core `inline()` driver and the `QueueDriver`
 * contract expose neither depth nor a dead-letter queue): `queue.depths` and
 * `queue.dlq` report `FEATURE_UNCONFIGURED`, and `queue.replay` (which replays
 * DLQ entries) does the same. `QueueRow.depth` is therefore always omitted. A
 * platform driver (Cloudflare Queues, Redis) with real depth/DLQ introspection
 * is the upgrade path. `queue.send` enqueues the opaque payload under a fixed
 * job name ({@link STUDIO_QUEUE_JOB_NAME}) — the frozen op carries no job name,
 * so the payload routes to the queue's wildcard `@Process()` handler.
 */
import { Inject, Injectable } from '@velajs/vela';
import { Container, EntrypointRegistry } from '@velajs/vela/module-kit';
import { QUEUE_DRIVER, QueueRegistry, queueToken } from '@velajs/vela/queue';
import type { QueueRow, StudioOpReq } from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext } from '../studio.types';
import { studioError } from '../studio.errors';
import { defineStudioPlugin, type StudioPlugin } from '../plugin';

/**
 * The job name `queue.send` enqueues under. The frozen `queue.send` op carries
 * only `{ queue, payload }` (no job name), so the payload is delivered under
 * this fixed name — caught by the queue's wildcard `@Process()` (unnamed)
 * handler.
 */
export const STUDIO_QUEUE_JOB_NAME = 'studio.send';

@Injectable()
export class StudioQueueOps {
  constructor(@Inject(Container) private readonly container: Container) {}

  @AdminRpc({ op: 'queue.list' })
  list(_ctx: AdminOpContext): QueueRow[] {
    const kind = this.driverKind();
    return this.queueNames().map((name) => ({ name, kind }));
  }

  @AdminRpc({ op: 'queue.depths' })
  depths(_ctx: AdminOpContext): never {
    // The core `QueueDriver` contract exposes no depth reading.
    throw studioError(
      'FEATURE_UNCONFIGURED',
      'the configured queue driver does not expose depth introspection',
    );
  }

  @AdminRpc({ op: 'queue.dlq' })
  dlq(_ctx: AdminOpContext): never {
    // The core `QueueDriver` contract exposes no dead-letter queue.
    throw studioError(
      'FEATURE_UNCONFIGURED',
      'the configured queue driver does not expose a dead-letter queue',
    );
  }

  @AdminRpc({ op: 'queue.send' })
  async send(ctx: AdminOpContext, args: StudioOpReq<'queue.send'>): Promise<{ id: string }> {
    const token = queueToken(args.queue);
    if (!this.container.has(token)) {
      throw studioError('FEATURE_UNCONFIGURED', `no queue named '${args.queue}' is registered`);
    }
    const client = this.container.resolve(token);
    const job = await client.add(STUDIO_QUEUE_JOB_NAME, args.payload);
    ctx.audit({ target: args.queue, summary: `enqueued a job to ${args.queue}` });
    return { id: job.id };
  }

  @AdminRpc({ op: 'queue.replay' })
  replay(_ctx: AdminOpContext): never {
    // Replay reads DLQ entries; the core driver has no DLQ (see `dlq`).
    throw studioError(
      'FEATURE_UNCONFIGURED',
      'the configured queue driver does not expose a dead-letter queue to replay',
    );
  }

  /** Distinct registered and `@Processor` queue names of this app (app-scoped). */
  private queueNames(): string[] {
    const names = new Set<string>();
    if (this.container.has(QueueRegistry)) {
      for (const queue of this.container.resolve(QueueRegistry).all()) names.add(queue.name);
    }
    if (!this.container.has(EntrypointRegistry)) return [...names].toSorted();
    const registry = this.container.resolve(EntrypointRegistry);
    for (const ep of registry.ofKind('queue')) {
      const meta = ep.meta;
      if (typeof meta === 'object' && meta !== null && 'queueName' in meta) {
        const queueName = (meta as { queueName: unknown }).queueName;
        if (typeof queueName === 'string') names.add(queueName);
      }
    }
    return [...names].toSorted();
  }

  /** The bound driver's `kind` (e.g. `inline`), or `unknown` when unresolvable. */
  private driverKind(): string {
    if (!this.container.has(QUEUE_DRIVER)) return 'unknown';
    const driver = this.container.resolve(QUEUE_DRIVER);
    return typeof driver.kind === 'string' ? driver.kind : 'unknown';
  }
}

/**
 * The queues panel: registers {@link StudioQueueOps}, lighting the `queue`
 * feature in apps with `QueueModule`:
 * `StudioModule.forRoot({ plugins: [queuesPanel()] })`.
 */
export function queuesPanel(): StudioPlugin {
  return defineStudioPlugin({ name: 'queues', providers: [StudioQueueOps] });
}
