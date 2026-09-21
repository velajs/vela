import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  createWorkflows,
  createWorkflowRunContext,
  defineStep,
  defineWorkflow,
  WorkflowNonRetryableError,
} from '@velajs/workflow';
import type { WorkflowBindingLike, WorkflowRunFunction } from '@velajs/workflow';
import { createReplayHarness } from '@velajs/workflow/harness';

const step = defineStep({
  name: 'schema-contract',
  args: { value: z.string().transform(Number), extra: z.number().default(1) },
  returns: z.string().transform(Number),
  handler: (_ctx, { value, extra }) => String(value + extra),
});
const harness = createReplayHarness();
const ctx = createWorkflowRunContext({
  env: {},
  event: { instanceId: 'consumer', workflowName: 'contract', timestamp: new Date(), payload: {} },
  exportName: 'contract',
  step: harness.step,
  run: async () => ({ amount: 1 }),
});
const result: number = await ctx.runStep(step, { value: '4' });
assert.equal(result, 5);
assert.equal(await ctx.runStep(step, { value: '4' }), 5);
assert.equal(harness.invocations('schema-contract'), 1);
const badResult = defineStep({ name: 'bad', args: {}, returns: z.string(), handler: () => 1 });
await assert.rejects(
  ctx.runStep(badResult, {}, { config: { retries: { limit: 3 } } }),
  WorkflowNonRetryableError,
);
assert.equal(harness.invocations('bad'), 1);
const workflow = defineWorkflow({
  handler: (ctx) => ctx.step.waitForEvent('approval', { type: 'yes' }),
});
const events = createReplayHarness();
assert.equal(
  (
    await events.runToCompletion(workflow, {
      params: {},
      deliver: { approval: { type: 'wrong', payload: true } },
    })
  ).status,
  'suspended',
);
assert.equal(
  (
    await events.runToCompletion(workflow, {
      params: {},
      deliver: { approval: { type: 'yes', payload: true } },
    })
  ).status,
  'complete',
);

// Compile-only negative checks verify packed declarations, not workspace source aliases.
function checkTypes(run: WorkflowRunFunction, binding: WorkflowBindingLike<{ id: string }>) {
  // @ts-expect-error input is a string before the schema transforms it
  void ctx.runStep(step, { value: 4 });
  // @ts-expect-error external dispatch cannot invent a domain result
  void run<{ id: string }>({ path: '/external' });
  // @ts-expect-error event payloads are unvalidated unknown values
  void ctx.step.waitForEvent<{ id: string }>('event', { type: 'ready' });
  const workflows = createWorkflows({ bindings: { order: binding } });
  void workflows.get('order').create({ params: { id: 'valid' } });
  // @ts-expect-error bindings determine params
  void workflows.get('order').create({ params: { id: 1 } });
  // @ts-expect-error unknown binding names are not accepted
  workflows.get('missing');
}
void checkTypes;
