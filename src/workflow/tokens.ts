import { InjectionToken } from '@velajs/vela';
import type { WorkflowDefinition } from '@velajs/workflow';

/**
 * A `defineWorkflow` result of ANY param/output type. `WorkflowDefinition` is
 * invariant in its `Params` (the phantom `__params` is covariant while `handler`
 * is contravariant), so a heterogeneous map of specifically-typed workflows can
 * only be held with `any` here — the standard element type for a mixed-generic
 * collection. Each workflow keeps its precise types where it is authored and
 * consumed individually (e.g. `createWorkflowEntrypoint`).
 */
// oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous workflow map element type
export type AnyWorkflowDefinition = WorkflowDefinition<any, any>;

/**
 * The declared {@link https://developers.cloudflare.com/workflows/ Cloudflare
 * Workflows} entrypoint kind. Every app-declared workflow becomes one
 * `cf:workflow` entrypoint so it is discoverable through
 * `app.entrypoints.ofKind('cf:workflow')` (CLI / OpenAPI / introspection).
 *
 * Unlike `cf:queue` / `cf:scheduled`, this kind is NOT runtime-dispatched by the
 * Worker: the platform instantiates the generated `WorkflowEntrypoint` class
 * directly, so the registry entry is observability-only.
 */
export const WORKFLOW_ENTRYPOINT_KIND = 'cf:workflow';

/**
 * Metadata key backing {@link WORKFLOW_ENTRYPOINT_KIND}. No decorator writes it
 * — workflow entrypoints are contributed by {@link WorkflowRegistry} (the
 * computed `ContributesEntrypoints` path), because `defineWorkflow` results are
 * plain objects, not decorated providers. The key exists only to satisfy the
 * `EntrypointKind` contract.
 */
export const WORKFLOW_ENTRYPOINT_META_KEY = 'vela:cf:workflow';

/**
 * Deterministic DI token for a single workflow's `Workflow` binding ref, keyed
 * by its export name. Registered by {@link WorkflowModule} as a `BindingRef`
 * `useValue` so `cloudflareAdapter`'s request middleware and
 * `buildWorkflowRuntime` both auto-initialize it from `env[bindingName]` with no
 * new init path.
 */
export const workflowBindingRefToken = (exportName: string): string =>
  `vela:cf:workflow-binding-ref:${exportName}`;

/**
 * The export-name → {@link WorkflowDefinition} map handed to
 * {@link WorkflowModule}. Injected by the entrypoint registry (and available to
 * app code) so the declared workflows are readable from the container.
 */
export const WORKFLOW_DEFINITIONS = new InjectionToken<Record<string, AnyWorkflowDefinition>>(
  'CF_WORKFLOW_DEFINITIONS',
);

/**
 * The introspection metadata carried on each `cf:workflow` entrypoint. All three
 * names come from `@velajs/workflow`'s pure derivations, so wrangler config, the
 * generated class const, and this registry entry agree by construction.
 */
export interface WorkflowEntrypointMeta {
  /** The `defineWorkflow` export name (`orderPipeline`). */
  exportName: string;
  /** The deployed `workflows[].name` (`order-pipeline`). */
  deployName: string;
  /** The generated `workflows[].class_name` (`OrderPipelineWorkflow`). */
  className: string;
  /** The `workflows[].binding` name (`WORKFLOW_ORDER_PIPELINE`). */
  bindingName: string;
}
