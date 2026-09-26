import { createDiscoverableDecorator } from '../discovery/discoverable.decorator';

export type Messages = Record<string, Record<string, unknown>>;

/** Stable metadata lets discovery find contributions from re-evaluated modules. */
export const MessageContribution = createDiscoverableDecorator<true>('vela:i18n:messages');

/** A value owned by one imported feature module, never by the process. */
@MessageContribution(true)
export class MessageContributionRecord {
  constructor(readonly messages: Messages) {
    Object.freeze(this);
  }
}

/** Snapshot the message tree so later caller mutations cannot change a registration. */
export function snapshotMessages(messages: Messages): Messages {
  const ancestors = new Set<object>();
  function snapshot(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      // ICU leaves are rendered as strings by MessageLoaderService. Capture
      // their value now rather than retaining mutable callable objects.
      return String(value);
    }
    if (ancestors.has(value))
      throw new TypeError('I18n messages must not contain circular values.');
    ancestors.add(value);
    const result = Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, child]) => [key, snapshot(child)])),
    );
    ancestors.delete(value);
    return result;
  }
  if (typeof messages !== 'object' || messages === null || Array.isArray(messages)) {
    throw new TypeError('I18n messages must be an object keyed by locale.');
  }
  for (const tree of Object.values(messages)) {
    if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) {
      throw new TypeError('Each I18n locale must contain a message object.');
    }
  }
  return snapshot(messages) as Messages;
}
