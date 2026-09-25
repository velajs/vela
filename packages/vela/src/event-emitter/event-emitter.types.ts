import type { EventDefinition } from './event-definition';

export type EventHandler = (...args: unknown[]) => void | Promise<void>;

export interface ScopedEventMetadata {
  definition: EventDefinition;
  methodName: string | symbol;
}
