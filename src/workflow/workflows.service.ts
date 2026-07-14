import { createWorkflows } from '@velajs/workflow';
import type { WorkflowBindingLike, WorkflowHandle, Workflows } from '@velajs/workflow';
import type { BindingRef } from '../binding-ref';

/**
 * The concrete `ctx.workflows` producer. Resolves each declared workflow's
 * `Workflow` binding from its (adapter-initialized) {@link BindingRef} and
 * delegates to `@velajs/workflow`'s `createWorkflows`.
 *
 * The bindings map is assembled LAZILY through per-key getters over the binding
 * refs, so a single instance works in both isolates: in the main Worker the refs
 * are filled by `cloudflareAdapter`'s request middleware on the first request,
 * and in a Workflow entrypoint isolate they are filled directly from `env` by
 * `buildWorkflowRuntime` — the ref is only read (`ref.value`) when a handle is
 * actually used, never at construction time.
 *
 * `get(name)` returns the typed handle for a declared workflow; an unrecognised
 * name throws `@velajs/workflow`'s wire-consistent `VelaError('internal', …)`.
 */
export class WorkflowsService implements Workflows {
  private producer: Workflows | undefined;

  constructor(private readonly refs: Record<string, BindingRef<WorkflowBindingLike>>) {}

  /**
   * Build the delegate once, over a bindings object whose properties are live
   * getters into the binding refs. `createWorkflows` reads `bindings[name]` (and
   * enumerates `Object.keys`) on each call, so every access reflects the current
   * ref value — including refs initialized after this service was constructed.
   */
  private resolve(): Workflows {
    if (this.producer === undefined) {
      const bindings: Record<string, WorkflowBindingLike> = {};
      for (const [name, ref] of Object.entries(this.refs)) {
        Object.defineProperty(bindings, name, {
          enumerable: true,
          get: (): WorkflowBindingLike => ref.value,
        });
      }
      this.producer = createWorkflows({ bindings });
    }
    return this.producer;
  }

  get<Params = Record<string, unknown>>(name: string): WorkflowHandle<Params> {
    return this.resolve().get<Params>(name);
  }
}
