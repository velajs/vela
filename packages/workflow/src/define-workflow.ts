/** Portable workflow declarations and optional naming conventions for adapter tooling. */
import type { WorkflowConfig, WorkflowDefinition } from './types';

/**
 * Break a camelCase export name apart at every lower/digit → upper transition:
 * `orderPipeline` → `['order', 'Pipeline']`, `etl` → `['etl']`. Implemented as a
 * zero-width split on the boundary so no characters are consumed.
 */
const camelSegments = (exportName: string): string[] => exportName.split(/(?<=[a-z0-9])(?=[A-Z])/);

/** Conventional class name: `orderPipeline` → `OrderPipelineWorkflow`. No class is generated. */
export const workflowClassName = (exportName: string): string => {
  const pascal = exportName.replace(/^[a-z]/, (head) => head.toUpperCase());
  return `${pascal}Workflow`;
};

/**
 * The wrangler binding name for an export: `orderPipeline` →
 * `WORKFLOW_ORDER_PIPELINE`, `etl` → `WORKFLOW_ETL`. The `WORKFLOW_` prefix keeps
 * these bindings clear of the platform's built-in binding names.
 */
export const workflowBindingName = (exportName: string): string => {
  const screamingSnake = camelSegments(exportName)
    .map((segment) => segment.toUpperCase())
    .join('_');
  return `WORKFLOW_${screamingSnake}`;
};

/**
 * The stable deployed workflow name (`workflows[].name`): `orderPipeline` →
 * `order-pipeline`. This is the fallback used whenever no explicit `name` is set.
 */
export const workflowDefaultName = (exportName: string): string =>
  camelSegments(exportName)
    .map((segment) => segment.toLowerCase())
    .join('-');

/**
 * Declare a portable workflow. This validates configuration and adds a brand.
 * It does not generate entrypoints, discover bindings, or modify Wrangler config.
 *
 * ```ts
 * // workflows.ts
 * import { defineWorkflow } from '@velajs/workflow';
 *
 * export const orderPipeline = defineWorkflow<{ orderId: string }>({
 *   handler: async (ctx) => {
 *     const order = await ctx.step.do('fetch-order', () =>
 *       ctx.run({ route: 'orders.get' }, { body: { id: ctx.params.orderId } }),
 *     );
 *     await ctx.step.sleep('settle', '1 minute');
 *     await ctx.step.do('capture-payment', () =>
 *       ctx.run({ route: 'payments.charge' }, { body: { orderId: ctx.params.orderId } }),
 *     );
 *     return order;
 *   },
 * });
 * ```
 */
export const defineWorkflow = <Params = Record<string, unknown>, Output = unknown>(
  config: WorkflowConfig<Params, Output>,
): WorkflowDefinition<Params, Output> => {
  if (typeof config.handler !== 'function') {
    throw new TypeError('defineWorkflow: expected `handler` to be a function');
  }

  if (
    config.name !== undefined &&
    (typeof config.name !== 'string' || config.name.trim().length === 0)
  ) {
    throw new TypeError('defineWorkflow: `name` must not be empty when supplied');
  }

  return { ...config, isVelaWorkflow: true };
};

/** True when `value` is a {@link defineWorkflow} result (the runtime brand check). */
export const isWorkflowDefinition = (value: unknown): value is WorkflowDefinition =>
  typeof value === 'object' &&
  value !== null &&
  (value as { isVelaWorkflow?: unknown }).isVelaWorkflow === true;
