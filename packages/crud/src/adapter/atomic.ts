import type { CrudAdapter, TransactionContext } from './contract';
import type { DeleteOptions, Lookup } from './query-types';
import { ConfigurationException } from '../envelope/errors';

/** Type-only result slot. Drivers must also authenticate commands at runtime. */
export const ATOMIC_RESULT: unique symbol = Symbol('vela.atomic.result');
export interface AtomicCommand<Result = unknown> {
  readonly [ATOMIC_RESULT]: Result;
}
export type AtomicResults<Commands extends readonly AtomicCommand[]> = {
  readonly [Index in keyof Commands]: Commands[Index] extends AtomicCommand<infer Result>
    ? Result
    : never;
};

/** Database commit succeeded, but a result decoder failed. Retrying may duplicate writes. */
export class AtomicBatchResultError extends Error {
  readonly committed = true;
  constructor(cause: unknown) {
    super('Atomic batch committed, but result validation failed', { cause });
    this.name = 'AtomicBatchResultError';
  }
}

export interface AtomicWriteOptions {
  /** Persist only when this write affects a row, in the same atomic boundary. */
  readonly audit?: AtomicCommand<void>;
}

/** Precomputed writes only. No JavaScript callbacks, reads, or result-dependent work. */
export interface AtomicBatchDriver<Row = Record<string, unknown>> {
  /** Exact native database identity, independent of callback scope registration. */
  readonly owner: object;
  create(input: Partial<Row>, options?: AtomicWriteOptions): AtomicCommand<Row>;
  /** A complete primary-key lookup is required; a scoped miss returns null. */
  update(
    lookup: Lookup,
    patch: Partial<Row>,
    options?: AtomicWriteOptions,
  ): AtomicCommand<Row | null>;
  delete(
    lookup: Lookup,
    options: DeleteOptions,
    write?: AtomicWriteOptions,
  ): AtomicCommand<Row | null>;
  /** Authenticate and validate EVERY command before sending any writes. */
  execute<const Commands extends readonly AtomicCommand[]>(
    commands: Commands,
    context?: TransactionContext,
  ): Promise<AtomicResults<Commands>>;
}

/** Require the optional capability at runtime, including custom adapters. */
export function requireAtomicBatch<Row>(
  adapter: Pick<CrudAdapter<Row>, 'capabilities' | 'atomicBatch'>,
): AtomicBatchDriver<Row> {
  const driver = adapter.atomicBatch;
  if (
    !adapter.capabilities.has('atomicBatch') ||
    !driver ||
    !driver.owner ||
    ['create', 'update', 'delete', 'execute'].some(
      (key) => typeof Reflect.get(driver, key) !== 'function',
    )
  ) {
    throw new ConfigurationException('Adapter does not support atomic write batches');
  }
  return driver;
}

export function executeAtomicBatch<const Commands extends readonly AtomicCommand[]>(
  adapter: Pick<CrudAdapter, 'runtime'>,
  commands: Commands,
  context?: TransactionContext,
): Promise<AtomicResults<Commands>> {
  return requireAtomicBatch(adapter.runtime).execute(commands, context);
}
