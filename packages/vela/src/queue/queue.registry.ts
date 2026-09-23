import { createDiscoverableDecorator } from '../discovery/discoverable.decorator';
import type { DiscoveryService } from '../discovery/discovery.service';
import type { QueueRegistration, RegisteredQueue } from './queue.types';

// The key is stable across Vite HMR re-evaluation; discovery reads each
// record's value structurally, so a re-evaluated class still counts.
const QueueRegistrationMarker = createDiscoverableDecorator<true>('vela:queue:registration');

const BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function readName(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim() !== value ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(
      `Queue registration ${field} must be a non-empty string without surrounding spaces.`,
    );
  }
  return value;
}

/** Validate one `registerQueue` entry and return a frozen copy. */
export function readQueueRegistration(value: unknown): QueueRegistration {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Queue registration must be an object with a name.');
  }
  const name = readName(Reflect.get(value, 'name'), 'name');
  const binding: unknown = Reflect.get(value, 'binding');
  if (binding !== undefined && (typeof binding !== 'string' || !BINDING_NAME.test(binding))) {
    throw new TypeError(
      `Queue '${name}' binding must be an identifier such as 'EMAIL_QUEUE' (a property of ENV).`,
    );
  }
  const consumer: unknown = Reflect.get(value, 'consumer');
  if (consumer !== undefined) readName(consumer, `consumer of '${name}'`);
  return Object.freeze({
    name,
    ...(binding === undefined ? {} : { binding }),
    ...(consumer === undefined ? {} : { consumer: consumer as string }),
  });
}

/**
 * The registration one `registerQueue` module instance provides. Every keyed
 * instance lists this one class token with its own record as the value, so
 * registering queues declares no class, and discovery reads the values
 * without constructing anything.
 */
@QueueRegistrationMarker(true)
export class QueueRegistrationRecord {
  constructor(readonly registration: QueueRegistration) {}
}

function registrationOf(record: unknown): QueueRegistration {
  return readQueueRegistration(
    typeof record === 'object' && record !== null ? Reflect.get(record, 'registration') : record,
  );
}

/**
 * The queues one application registered with `QueueModule.registerQueue`,
 * merged by name. Several modules may register the same queue: their
 * bindings must agree (an omitted binding agrees with any), and their
 * `consumer` pins accumulate. A disagreement fails bootstrap.
 *
 * Drivers receive it through their factory context; `QueueModule` exports it
 * for tools that list an application's queues.
 */
export class QueueRegistry {
  readonly #queues = new Map<string, RegisteredQueue>();

  constructor(registrations: Iterable<QueueRegistration>) {
    for (const input of registrations) {
      const registration = readQueueRegistration(input);
      const existing = this.#queues.get(registration.name);
      if (
        existing?.binding !== undefined &&
        registration.binding !== undefined &&
        existing.binding !== registration.binding
      ) {
        throw new Error(
          `Queue '${registration.name}' is registered with conflicting bindings ` +
            `'${existing.binding}' and '${registration.binding}'. A queue sends through one ` +
            `binding: register it with the same binding everywhere, or omit the binding where ` +
            `a module only consumes it.`,
        );
      }
      const consumers = [...(existing?.consumers ?? [])];
      if (registration.consumer !== undefined && !consumers.includes(registration.consumer)) {
        consumers.push(registration.consumer);
      }
      this.#queues.set(
        registration.name,
        Object.freeze({
          name: registration.name,
          binding: existing?.binding ?? registration.binding,
          consumers: Object.freeze(consumers),
        }),
      );
    }
  }

  /** Collect the registrations of every module in an application, without constructing them. */
  static discover(discovery: DiscoveryService): QueueRegistry {
    return new QueueRegistry(
      discovery
        .registrationsWithMeta(QueueRegistrationMarker)
        .map(({ instance }) => registrationOf(instance)),
    );
  }

  /** The merged registration of a logical queue, or `undefined` when none registered it. */
  get(name: string): RegisteredQueue | undefined {
    return this.#queues.get(name);
  }

  has(name: string): boolean {
    return this.#queues.has(name);
  }

  /** Every registered queue, sorted by name. */
  all(): RegisteredQueue[] {
    return [...this.#queues.values()].toSorted((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }
}
