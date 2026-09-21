# @velajs/workflow

Portable workflow definitions, reusable Zod 4 validated steps, and an in-memory
replay harness. Use this package to share orchestration logic between an execution
adapter and tests, or to test approval and agent loops without Workers tooling.

The root and `/harness` entrypoints use Web APIs and import no Node, Vela core, or
Cloudflare runtime modules. `@velajs/errors` is the shared runtime error layer.
Install Zod 4 alongside the package; schemas are called at runtime even though
this package's Zod import is type-only.

```sh
pnpm add @velajs/workflow zod@^4.4.3
```

## Supported API

| Export | Responsibility |
| --- | --- |
| `defineWorkflow`, `isWorkflowDefinition` | Validate and brand workflow configuration. No execution or discovery. |
| `defineStep`, `isStepDefinition` | Declare argument schemas, an optional result schema, a handler, and adapter configuration. |
| `createWorkflowRunContext` | Assemble one invocation's params, event, env, logger, injected `run`, `runStep`, and step adapter. |
| `createRunStep`, `validateStepArgs` | Validate step input, invoke `step.do`, validate output, forward rollback options and terminal errors. |
| `createWorkflows` | Wrap an explicitly supplied map of producer bindings. Infer names and params from that map. |
| `createWorkflowLogger` | Console logger with an invocation prefix. |
| `workflowClassName`, `workflowBindingName`, `workflowDefaultName` | Pure naming conventions for tooling; no generator is included. |
| `WorkflowNonRetryableError`, `isNonRetryableError` | Portable terminal-error signal honored by the harness. |
| `convertNonRetryableError`, `toNativeNonRetryableError` | Optional adapter helpers to reconstruct that signal with a supplied error constructor. |
| `/harness`: `createReplayHarness`, `WorkflowSuspended` | In-memory checkpoint, retry and event-suspension tests. |

The exported `*Like` types are portable adapter contracts, not promises of exact
compatibility with every version of Cloudflare's native types. The package also
exports the configuration, input inference, handler, binding and context types.

## Validated reusable steps

```ts
import { defineStep, defineWorkflow, WorkflowNonRetryableError } from '@velajs/workflow';
import { z } from 'zod';

const charge = defineStep({
  name: 'charge',
  args: {
    orderId: z.string(),
    amount: z.string().transform(Number),
    currency: z.string().default('USD'),
  },
  returns: z.object({ receiptId: z.string() }),
  config: { retries: { limit: 2 } },
  handler: (ctx, args) => ctx.run({ path: '/payments/charge' }, { body: args }),
});

export const order = defineWorkflow<{ orderId: string }, { receiptId: string }>({
  handler: async (ctx) => {
    const event = await ctx.step.waitForEvent('approval', { type: 'approved' });
    const approval = z.object({ approved: z.boolean() }).parse(event.payload);
    if (!approval.approved) throw new WorkflowNonRetryableError('rejected');
    return ctx.runStep(charge, { orderId: ctx.params.orderId, amount: '25' });
  },
});
```

`InferStepInput` describes raw values accepted by `runStep`, including omitted
optional/defaulted keys. `InferStepArgs` describes parsed values received by the
handler. A `returns` schema owns the output type and can transform the handler's
unknown result. Without `returns`, output is inferred from the handler. The
schemas must be synchronous; asynchronous refinements are unsupported.

Argument validation occurs before `step.do` and on each handler replay. Only
own, declared keys are read; extra keys are removed. Invalid arguments or a
result rejected by its schema throw `WorkflowNonRetryableError`. Ordinary handler
errors, including `VelaError`, propagate unchanged for adapter retry policy. No
automatic HTTP-status-to-terminal-error mapping is performed. Schemas and
transforms should be deterministic and free of side effects.

A step's name is its stable checkpoint key in the harness. Reuse with different
arguments needs a distinct label:

```ts
await ctx.runStep(charge, args, { name: `charge:${args.orderId}` });
```

`options.config` replaces the declared step configuration. Optional `rollback`
receives parsed args, output, error, env, logger and dispatch; `rollbackConfig` is
forwarded. Execution and scheduling of compensation belong to the adapter.

## Execution and Vela dispatch boundaries

An adapter calls `createWorkflowRunContext({ env, event, exportName, run, step })`
and passes the resulting context to `definition.handler(context)`. Validate
external `event.payload` with an application schema **before** creating its typed
context: `defineWorkflow<Params>` does not validate runtime trigger data.
The factory holds no global request, environment, or tenant state.

`WorkflowRunFunction` returns `Promise<unknown>` and accepts a named route or path,
plus `method`, `body`, `headers: HeadersInit`, `ttlSeconds`, `iss`, `signal`, and
`timeoutMs`. Validate returned data explicitly or use a step's `returns` schema.
An application can inject its own dispatcher, including a correctly bound Vela
`InternalDispatcher.run`. This package does not instantiate a dispatcher, sign
requests, grant authorization, or build a cross-isolate transport. Named route
checking remains the application's responsibility.

`ctx.run` itself adds no durability. Put side effects inside `ctx.step.do` or
`ctx.runStep` to memoize successful results. A crash after an external effect but
before a checkpoint can still repeat that effect; use stable, instance-scoped
idempotency keys at the destination. Code outside steps is re-executed on replay.
Do not depend on mutable ambient tenant/request state inside a workflow.

## Replay harness

```ts
import { createReplayHarness } from '@velajs/workflow/harness';

const harness = createReplayHarness();
const params = { orderId: 'order-42' }; // validate external params first
const run = async () => ({ receiptId: 'receipt-42' });
await harness.runToCompletion(order, { params, run }); // suspended
const result = await harness.runToCompletion(order, {
  params, run,
  deliver: { approval: { type: 'approved', payload: { approved: true } } },
});
if (result.status === 'complete') console.log(result.output.receiptId);
```

Use one harness per workflow instance. It generates a unique instance ID. Keep
the same definition reference and explicit environment object between runs, and
supply the same JSON trigger params (object-key ordering is ignored). Changed
params, environment, or definition require a fresh harness or `reset()`. Params
must be acyclic plain JSON values; omit absent properties instead of setting them
to `undefined`. Reset also generates a new instance ID. Concurrent top-level runs
and reset during active execution are rejected.

- Successful `do` results, including `undefined`, are memoized. Values are copied
  with `structuredClone`; mutations cannot corrupt later replay. Non-cloneable
  results fail. Concurrent calls sharing a label share pending work.
- `config.retries.limit` counts retries after the first attempt. The harness
  defaults to zero retries; configured retries happen immediately. `attempt`
  starts at one. Terminal errors and suspension signals bypass retries. Failed
  steps are not cached; a later explicit run may attempt them again.
- `waitForEvent` suspends through `WorkflowSuspended`. `deliver` is indexed by
  wait name and must also match the event type. Mismatched events leave the
  workflow suspended. The first matching delivery is memoized; duplicates cannot
  replace it. Payloads remain `unknown`. Unconsumed deliveries are local to that
  call, not a persistent event queue.
- `sleep` and `sleepUntil` record checkpoints immediately. Timeout values, retry
  delays and backoff are not scheduled. Rollback options fail explicitly because
  compensation is not simulated. The harness is not a Cloudflare emulator.
- `maxReplays` bounds automatic event resumes, not arbitrary handler execution.
  `invocations(name)` counts all actual body attempts, including failures;
  `ran`, `completedSteps`, and `deliveredEvents` expose the local log.

Run the [approval example](../../apps/workflow-lab/README.md) with
`pnpm --filter @velajs/example-workflow-lab start` after building dependencies.

## Cloudflare integration status

This migration includes **no native Workflows adapter**. Neither this package nor
the current `@velajs/cloudflare` package generates `WorkflowEntrypoint` classes,
wires `ctx.workflows`, discovers definitions, or registers Wrangler workflows.
`createWorkflows` only wraps bindings supplied by the caller. There is no
cross-isolate workflow transport, native retry verification, child-workflow
fan-out, or durable storage in the harness.

A future native adapter belongs in an explicit Cloudflare entrypoint and needs
native Workers tests for serialization, error conversion, scheduling and replay.
Use Cloudflare's [native Workflows guide](https://developers.cloudflare.com/workflows/get-started/guide/)
and [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
for native deployments. An in-memory test pass does not verify a native deployment.

## Migration from the standalone source

The standalone repository's local manifest was `0.1.0`; the public npm lookup
returned E404 on 2026-09-21. This monorepo starts at `1.0.0` and uses the root
Changesets/release process. Original MIT license and changelog are retained;
source lineage: `velajs/workflow`, commit
`c4319e3c3a3e7c96fccedfa4351f41c148686a97`.

Intentional API changes: Zod 4 replaces the Zod 3 peer; `runStep` accepts raw
schema inputs; `returns` infers parsed output; dispatch and event payloads no
longer allow caller-invented generic result types; binding handle names and
params infer from the registry. The harness now validates matching events,
counts failed attempts, honors retry limits, isolates cached values and instance
identity, and explicitly rejects unsupported compensation. Legacy comments
about automatic native wiring described deferred work and were not implemented.
