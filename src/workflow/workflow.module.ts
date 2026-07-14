import { registerEntrypointKind } from '@velajs/vela';
import type { DynamicModule, ProviderOptions } from '@velajs/vela';
import { workflowBindingName } from '@velajs/workflow';
import type { WorkflowBindingLike } from '@velajs/workflow';
import { BindingRef } from '../binding-ref';
import { WorkflowRegistry } from './workflow-registry';
import { WorkflowsService } from './workflows.service';
import {
  WORKFLOW_DEFINITIONS,
  WORKFLOW_ENTRYPOINT_KIND,
  WORKFLOW_ENTRYPOINT_META_KEY,
  workflowBindingRefToken,
  type AnyWorkflowDefinition,
} from './tokens';

// Declare the `cf:workflow` entrypoint kind at import time, next to the module —
// exactly like `cf:vela-cron` is declared at the top of cloudflare-application.ts.
// Entries are contributed by WorkflowRegistry (computed), so the metaKey is only
// here to satisfy the EntrypointKind contract; no decorator ever writes it.
registerEntrypointKind({
  kind: WORKFLOW_ENTRYPOINT_KIND,
  metaKey: WORKFLOW_ENTRYPOINT_META_KEY,
  level: 'class',
});

/** Options for {@link WorkflowModule.forRoot}. */
export interface WorkflowModuleOptions {
  /**
   * The export-name → `defineWorkflow` result map, e.g. `{ orderPipeline }`. The
   * export name drives every derived identifier (binding, deploy, and class
   * names) through `@velajs/workflow`'s pure derivations, so wrangler config, the
   * generated entrypoint class const, and the `cf:workflow` registry all agree.
   */
  workflows: Record<string, AnyWorkflowDefinition>;
}

/**
 * Wires app-declared Cloudflare Workflows into a Vela app. Import it on your
 * `AppModule` and hand it the same workflow map your entrypoint file re-exports
 * from (`createWorkflowEntrypoints`), so each workflow is declared exactly once:
 *
 * ```ts
 * // workflows.ts
 * export const orderPipeline = defineWorkflow<{ orderId: string }>({ handler });
 *
 * // app.module.ts
 * import * as workflows from './workflows';
 * @Module({ imports: [WorkflowModule.forRoot({ workflows })] })
 * export class AppModule {}
 * ```
 *
 * Per workflow export `N` it provides, all from the one source object:
 * - a `BindingRef(workflowBindingName(N))` (`useValue`) — auto-initialized by
 *   `cloudflareAdapter`'s request middleware AND `buildWorkflowRuntime`, no new
 *   init path;
 * - {@link WorkflowsService} — the injectable `ctx.workflows` producer over those
 *   refs;
 * - {@link WorkflowRegistry} — the `ContributesEntrypoints` provider that surfaces
 *   every workflow as a `cf:workflow` entrypoint for introspection.
 */
export class WorkflowModule {
  static forRoot(options: WorkflowModuleOptions): DynamicModule {
    const workflows = options.workflows;
    const exportNames = Object.keys(workflows);

    // One BindingRef instance per workflow, shared between the DI registration
    // (so adapters initialize it) and WorkflowsService (so it reads the same
    // initialized value).
    const refs: Record<string, BindingRef<WorkflowBindingLike>> = {};
    const providers: ProviderOptions[] = [];

    for (const name of exportNames) {
      const ref = new BindingRef<WorkflowBindingLike>(workflowBindingName(name));
      refs[name] = ref;
      providers.push({ provide: workflowBindingRefToken(name), useValue: ref });
    }

    providers.push(
      { provide: WORKFLOW_DEFINITIONS, useValue: workflows },
      { provide: WorkflowsService, useFactory: (): WorkflowsService => new WorkflowsService(refs) },
      {
        provide: WorkflowRegistry,
        useFactory: (): WorkflowRegistry => new WorkflowRegistry(workflows),
      },
    );

    // The per-workflow binding refs are registered (so adapters auto-initialize
    // them via getUseValues) but NOT exported: nothing outside the module injects
    // them — WorkflowsService holds the same ref instances directly.
    return {
      module: WorkflowModule,
      providers,
      exports: [WorkflowsService, WORKFLOW_DEFINITIONS],
    };
  }
}
