/**
 * `defineStep` — author a reusable, schema-validated durable step. Pure
 * validation plus branding (Node-safe, no runtime imports), mirroring
 * `defineWorkflow`. A step bundles a zod args map, an optional zod `returns`
 * schema, the work to perform, and an optional rollback handler; run it from a
 * workflow body with `ctx.runStep(step, args)`, which validates the args before
 * the body runs and the result after.
 */
import type { StepArgsShape, StepConfig, StepDefinition, StepHandler } from './types';

/**
 * Declare a reusable durable step.
 *
 * ```ts
 * // steps.ts
 * import { defineStep } from '@velajs/workflow';
 * import { z } from 'zod';
 *
 * export const chargeOrder = defineStep({
 *   name: 'charge order',
 *   args: { orderId: z.string() },
 *   returns: z.object({ receiptId: z.string() }),
 *   handler: async (ctx, { orderId }) =>
 *     ctx.run({ route: 'payments.charge' }, { body: { orderId } }),
 * });
 * ```
 */
export function defineStep<A extends StepArgsShape, Result>(
  config: StepConfig<A, Result> & { returns: NonNullable<StepConfig<A, Result>['returns']> },
): StepDefinition<A, Result>;
export function defineStep<A extends StepArgsShape, Result>(
  config: Omit<StepConfig<A, Result>, 'handler' | 'returns'> & {
    handler: StepHandler<A, Result>;
    returns?: never;
  },
): StepDefinition<A, Result>;
export function defineStep<A extends StepArgsShape, Result>(
  config: StepConfig<A, Result>,
): StepDefinition<A, Result> {
  if (typeof config.name !== 'string' || config.name.trim().length === 0) {
    throw new TypeError('defineStep: `name` must be a non-empty string (the durable step label)');
  }

  // Runtime guard for untrusted JS callers despite the required type. Read
  // through `unknown` so the null-check is meaningful rather than a
  // statically-impossible comparison.
  const declaredArgs = config.args as unknown;

  if (typeof declaredArgs !== 'object' || declaredArgs === null || Array.isArray(declaredArgs)) {
    throw new TypeError(
      'defineStep: `args` must be a map of zod schemas (e.g. `{ id: z.string() }`)',
    );
  }

  for (const schema of Object.values(config.args)) {
    if (!schema || typeof schema.safeParse !== 'function') {
      throw new TypeError('defineStep: `args` must be a map of zod schemas');
    }
  }
  if (config.returns !== undefined && typeof config.returns?.safeParse !== 'function') {
    throw new TypeError('defineStep: `returns` must be a zod schema');
  }

  if (typeof config.handler !== 'function') {
    throw new TypeError('defineStep: `handler` must be a function (the step body)');
  }

  if (config.rollback !== undefined && typeof config.rollback !== 'function') {
    throw new TypeError('defineStep: `rollback` must be a function when provided');
  }

  // Spread the config so optional fields that are absent stay absent (rather than
  // being pinned to `undefined`, which `exactOptionalPropertyTypes` rejects).
  return { ...config, isVelaStep: true };
}

/** True when `value` is a {@link defineStep} result (the runtime brand check). */
export const isStepDefinition = (value: unknown): value is StepDefinition =>
  typeof value === 'object' &&
  value !== null &&
  (value as { isVelaStep?: unknown }).isVelaStep === true;
