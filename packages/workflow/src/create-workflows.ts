import { VelaError } from '@velajs/errors';
import type {
  CreateWorkflowsOptions,
  WorkflowBindingLike,
  WorkflowHandle,
  Workflows,
} from './types';

/** Wrap only explicitly supplied bindings. The registry is scoped to this call. */
export const createWorkflows = <B extends Record<string, WorkflowBindingLike<never>>>(
  options: CreateWorkflowsOptions<B>,
): Workflows<B> => {
  const registry = new Map(Object.entries(options.bindings));
  return {
    get: <Name extends keyof B & string>(name: Name) => {
      const binding = registry.get(name);
      if (binding === undefined) {
        const names = [...registry.keys()];
        const hint = names.length
          ? `available: ${names.join(', ')}`
          : 'the workflow registry is empty';
        throw new VelaError('internal', {
          message: `@velajs/workflow: unknown workflow "${name}" — ${hint}`,
        });
      }
      // The binding was selected by a key of B; this cast only restores that key's parameter type.
      type Params = B[Name] extends WorkflowBindingLike<infer P> ? P : never;
      const selected = binding as WorkflowBindingLike<Params>;
      return {
        create: (options) => selected.create(options),
        createBatch: (batch) => selected.createBatch(batch),
        get: (id) => selected.get(id),
      } satisfies WorkflowHandle<Params>;
    },
  };
};
