export type EventHandler = (...args: unknown[]) => void | Promise<void>;

export interface OnEventMetadata {
  event: string;
  methodName: string;
}
