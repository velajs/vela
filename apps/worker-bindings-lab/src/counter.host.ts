import { Inject, Injectable } from '@velajs/vela';
import { DO_ID, DO_STORAGE } from '@velajs/cloudflare/durable-objects';

/** What `CounterHost.status()` answers over RPC. */
export interface CounterStatus {
  durableObject: true;
  name: string;
  hits: number;
}

/**
 * The Counter Durable Object's host: one instance per name, with its own
 * storage. Its public methods are the object's RPC methods, typed on the
 * `COUNTER_DO` binding: `await env.COUNTER_DO.getByName('main').status()`.
 */
@Injectable()
export class CounterHost {
  constructor(
    @Inject(DO_ID) private readonly id: DurableObjectId,
    @Inject(DO_STORAGE) private readonly storage: DurableObjectStorage,
  ) {}

  async status(): Promise<CounterStatus> {
    const hits = ((await this.storage.get<number>('hits')) ?? 0) + 1;
    await this.storage.put('hits', hits);
    return { durableObject: true, name: this.id.name ?? this.id.toString(), hits };
  }
}
