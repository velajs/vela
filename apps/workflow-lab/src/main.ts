import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineStep, defineWorkflow, WorkflowNonRetryableError } from '@velajs/workflow';
import { createReplayHarness } from '@velajs/workflow/harness';

const paramsSchema = z.object({ orderId: z.string() });
const approvalSchema = z.object({ approved: z.boolean() });
const charge = defineStep({
  name: 'charge',
  args: { orderId: z.string(), amount: z.string().transform(Number) },
  returns: z.object({ receiptId: z.string() }),
  config: { retries: { limit: 1 } },
  handler: (ctx, args) => ctx.run({ path: '/payments/charge' }, { body: args }),
});
const workflow = defineWorkflow<z.output<typeof paramsSchema>, { receiptId: string }>({
  name: 'order-approval',
  handler: async (ctx) => {
    const amount = await ctx.step.do('quote', async () => '25');
    const event = await ctx.step.waitForEvent('approval', { type: 'approved' });
    const approval = approvalSchema.parse(event.payload);
    if (!approval.approved) throw new WorkflowNonRetryableError('order was rejected');
    return ctx.runStep(charge, { orderId: ctx.params.orderId, amount });
  },
});

const harness = createReplayHarness();
// An HTTP receiver or native adapter must validate trigger params before supplying a typed context.
const params = paramsSchema.parse({ orderId: 'order-42' });
let attempts = 0;
const run = async () => {
  attempts += 1;
  if (attempts === 1) throw new Error('temporary payment failure');
  return { receiptId: 'receipt-42' };
};
assert.equal((await harness.runToCompletion(workflow, { params, run })).status, 'suspended');
const completed = await harness.runToCompletion(workflow, {
  params,
  run,
  deliver: { approval: { type: 'approved', payload: { approved: true } } },
});
assert.deepEqual(completed.output, { receiptId: 'receipt-42' });
await harness.runToCompletion(workflow, { params, run });
assert.equal(harness.invocations('quote'), 1);
assert.equal(harness.invocations('charge'), 2);
assert.equal(attempts, 2);
// oxlint-disable-next-line no-console -- runnable example result
console.log('PASS: approval suspension, validated dispatch, retry, and memoized replay');
