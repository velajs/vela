export type EventHandler = (...args: unknown[]) => void | Promise<void>;

export interface OnEventMetadata {
  event: string;
  methodName: string;
}

export interface EventEmitOptions {
  /** Legacy fails fast between groups; complete awaits every matching listener. */
  settlement?: 'legacy' | 'complete';
}
