import './vela-env';
// Tail Workers: importing OnTail gives the Worker (`app.worker`) its `tail` handler.
export { OnTail } from './tail/on-tail';
export type { OnTailDecorator } from './tail/on-tail';
export type { TailExecutionContext } from './tail/tail-dispatch';
