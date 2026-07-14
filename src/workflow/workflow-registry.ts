import { workflowBindingName, workflowClassName, workflowDefaultName } from '@velajs/workflow';
import type { ContributesEntrypoints, Entrypoint } from '@velajs/vela';
import {
  WORKFLOW_ENTRYPOINT_KIND,
  workflowBindingRefToken,
  type AnyWorkflowDefinition,
  type WorkflowEntrypointMeta,
} from './tokens';

/**
 * Contributes one `cf:workflow` {@link Entrypoint} per declared workflow so the
 * app's workflows are discoverable via `app.entrypoints.ofKind('cf:workflow')`.
 *
 * This is the COMPUTED (`ContributesEntrypoints`) registration path, which is the
 * only correct one here: `defineWorkflow` results are plain objects (not
 * decorated providers), so there is nothing for a metadata-key sweep to find and
 * no decorator to invent. The registry is picked up because this class is an
 * eagerly instantiated provider — `EntrypointRegistry.build` scans the app's
 * instances for `collectEntrypoints`, and a contributor is authoritative for the
 * `cf:workflow` kind.
 *
 * The entry is observability-only: the platform instantiates the generated
 * `WorkflowEntrypoint` class directly, so nothing in the Worker dispatches this
 * kind at runtime.
 */
export class WorkflowRegistry implements ContributesEntrypoints {
  constructor(private readonly workflows: Record<string, AnyWorkflowDefinition>) {}

  collectEntrypoints(): Entrypoint[] {
    return Object.keys(this.workflows).map((exportName) => {
      const definition = this.workflows[exportName];
      const meta: WorkflowEntrypointMeta = {
        exportName,
        deployName: definition?.name ?? workflowDefaultName(exportName),
        className: workflowClassName(exportName),
        bindingName: workflowBindingName(exportName),
      };
      return {
        kind: WORKFLOW_ENTRYPOINT_KIND,
        // The workflow's binding-ref token identifies the entry; no provider
        // instance backs it (the platform owns the class), so `instance` is
        // undefined — introspection reads everything it needs from `meta`.
        token: workflowBindingRefToken(exportName),
        instance: undefined,
        meta,
      } satisfies Entrypoint<WorkflowEntrypointMeta>;
    });
  }
}
