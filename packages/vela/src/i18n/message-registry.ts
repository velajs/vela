import { Inject, Injectable } from '../container/decorators';
import { DiscoveryService } from '../discovery/discovery.service';
import { deepMerge } from './deep-merge';
import { MessageContribution, type Messages } from './message-contribution';

/** Messages contributed by feature modules imported into this application. */
@Injectable()
export class MessageRegistry {
  constructor(@Inject(DiscoveryService) private readonly discovery: DiscoveryService) {}

  /** Deep-merge in module registration order; later contributions override leaves. */
  getMergedMessages(): Record<string, Record<string, unknown>> {
    const merged: Messages = {};
    for (const { instance } of this.discovery.registrationsWithMeta(MessageContribution)) {
      const messages: unknown =
        typeof instance === 'object' && instance !== null
          ? Reflect.get(instance, 'messages')
          : undefined;
      if (typeof messages !== 'object' || messages === null || Array.isArray(messages)) {
        throw new TypeError('Invalid I18n message contribution.');
      }
      for (const [locale, tree] of Object.entries(messages)) {
        if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) {
          throw new TypeError('Invalid I18n locale contribution.');
        }
        Object.defineProperty(merged, locale, {
          value: deepMerge(Object.hasOwn(merged, locale) ? merged[locale]! : {}, tree),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return merged;
  }
}
