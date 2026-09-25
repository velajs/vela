import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';

/**
 * A decorator whose annotated classes/methods are findable through
 * `DiscoveryService` by the decorator itself (no string key at the call site).
 */
export interface DiscoverableDecorator<T> {
  (value: T): ClassDecorator & MethodDecorator;
  /** The metadata key backing this decorator — stable across HMR re-evals. */
  KEY: string;
}

export interface CreateDiscoverableDecoratorOptions {
  /**
   * Append to a class-level list instead of overwriting a single slot —
   * for stackable method decorators (`@Cron`-style: each application pushes
   * `{ methodName, ...value }` onto the class's list, which
   * `DiscoveryService.registeredMethodsWithMeta` flattens back to per-method entries).
   */
  append?: boolean;
}

/**
 * Mint a discoverable decorator for a module's extension surface:
 *
 * ```ts
 * export interface QueueConsumerMeta { queue: string }
 * export const QueueConsumer = createDiscoverableDecorator<QueueConsumerMeta>('vela:queue:consumer');
 *
 * @QueueConsumer({ queue: 'emails' })
 * class EmailConsumer { ... } // a class decorator implies @Injectable()
 *
 * // At bootstrap, anywhere:
 * discovery.registrationsWithMeta(QueueConsumer)  // typed { meta: QueueConsumerMeta }
 * ```
 *
 * Unlike `Reflector.createDecorator`, the key is required and caller-chosen:
 * a random key would mint a fresh identity on every HMR re-eval and orphan
 * previously-decorated classes. Namespace it (`'<pkg>:<area>:<thing>'`).
 */
export function createDiscoverableDecorator<T>(
  key: string,
  options: CreateDiscoverableDecoratorOptions = {},
): DiscoverableDecorator<T> {
  const decorator = (value: T) => {
    return (target: object, propertyKey?: string | symbol): void => {
      const ctor =
        propertyKey !== undefined ? (target.constructor as Constructor) : (target as Constructor);
      if (options.append) {
        if (propertyKey !== undefined) {
          MetadataRegistry.appendCustomClassMeta(ctor, key, {
            methodName: propertyKey,
            ...(value as object),
          });
        } else {
          MetadataRegistry.appendCustomClassMeta(ctor, key, value);
        }
      } else if (propertyKey !== undefined) {
        MetadataRegistry.setCustomHandlerMeta(ctor, propertyKey, key, value);
      } else {
        MetadataRegistry.setCustomClassMeta(ctor, key, value);
      }
      // As a class decorator it implies @Injectable(); a declared scope stays.
      if (propertyKey === undefined) MetadataRegistry.markInjectable(ctor);
    };
  };
  (decorator as DiscoverableDecorator<T>).KEY = key;
  return decorator as DiscoverableDecorator<T>;
}
