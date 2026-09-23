import type { DiscoveryService } from '../index';
import type { QueueRegistration, RegisteredQueue } from './queue.types';

// The record rides on a per-registration class as a static property keyed by a
// registry symbol, so it survives Vite HMR re-evaluation and MetadataRegistry
// resets alike, and discovery reads it without constructing anything.
const REGISTRATION = Symbol.for('vela:queue:registration:v1');

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

/** Attach a registration to the class `registerQueue` declares for it. */
export function attachQueueRegistration(target: object, registration: QueueRegistration): void {
  Object.defineProperty(target, REGISTRATION, { value: registration });
}

function registrationOf(token: unknown): QueueRegistration | undefined {
  if (typeof token !== 'function' || !Object.hasOwn(token, REGISTRATION)) return undefined;
  return readQueueRegistration(Reflect.get(token, REGISTRATION));
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
    const registrations: QueueRegistration[] = [];
    for (const found of discovery.getRegistrations({ metadataOnly: true })) {
      const registration = registrationOf(found.token);
      if (registration) registrations.push(registration);
    }
    return new QueueRegistry(registrations);
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
