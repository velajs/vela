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

## Cloudflare and dependency injection

The portable root and `/harness` remain independent of Vela and Cloudflare.
`VelaWorkflow(app, Host)` from `@velajs/cloudflare/workflows` runs an injectable
class whose `run(event, step)` uses the native platform API. For a portable
definition, use the separate `@velajs/cloudflare/workflow-definitions` entrypoint:

```ts
import { Injectable, Module } from '@velajs/vela';
import { InternalDispatcher } from '@velajs/vela/dispatch';
import { defineCloudflareApp } from '@velajs/cloudflare';
import { VelaWorkflowDefinition } from '@velajs/cloudflare/workflow-definitions';
import { defineWorkflow, WorkflowNonRetryableError } from '@velajs/workflow';
import { z } from 'zod';

@Injectable()
class Calculator {
  async double(value: number) { return value * 2; }
}
@Module({ providers: [Calculator] })
class AppModule {}
const app = defineCloudflareApp(AppModule);
const params = z.object({ value: z.string().regex(/^\d+$/).transform(Number) });

export class ExampleWorkflow extends VelaWorkflowDefinition(app, {
  params,
  inject: [Calculator, InternalDispatcher],
  useFactory: (calculator, dispatcher) => ({
    definition: defineWorkflow<z.output<typeof params>, number>({
      handler: (ctx) => ctx.step.do('double', () => calculator.double(ctx.params.value)),
    }),
    run: (target, init) => {
      if (!('path' in target)) {
        throw new WorkflowNonRetryableError('This dispatcher accepts path targets only.');
      }
      return dispatcher.run(target, init);
    },
  }),
}) {}
export default app.worker;
```

Register the exported class explicitly in Wrangler:

```toml
[[workflows]]
name = "example"
binding = "EXAMPLE_WORKFLOW"
class_name = "ExampleWorkflow"
```

The binding accepts the schema's **input** (`{ value: '7' }`); the handler receives
its validated **output** (`{ value: 7 }`). Validation finishes before application
startup, dependency resolution, or `useFactory`. A validation rejection becomes a native
`NonRetryableError`; an exception thrown by validator code remains an ordinary
failure. The factory runs for each native invocation, including replay. Keep
schemas, step names, and factory behavior stable for in-flight workflows.

`inject` infers literal and readonly tuples. Dependencies resolve through the
root module's normal visibility and the current run's execution scope. Export
providers from feature modules when the root imports them. Request-scoped
resources are disposed when the invocation finishes; another environment has a
different application. An existing typed `WorkflowDefinition` token can be one
of the injected dependencies, with the factory returning that definition.

The required `run` function is the application's dispatcher. It never acquires
identity or tenant authority from trigger fields. `InternalDispatcher` signs its
calls and runs the destination's request pipeline; configure its signing secret
and authorize the destination as usual. This example accepts path targets;
applications using named routes map the portable route name to an allowed,
typed application route. Put dispatch effects in durable steps.

Native Workflows owns checkpoints, serialization, waits, retries and rollback.
The bridge converts `WorkflowNonRetryableError` inside step and rollback
callbacks before the engine retries them, and converts terminal errors leaving
the handler. Ordinary errors and engine pause/restart interruptions retain their
behavior. Numeric durations are milliseconds; strings use native duration units.
An omitted retry delay uses Cloudflare's default ten seconds. The replay harness
still does not emulate native scheduling or compensation.

There is no automatic binding discovery or Wrangler generation. The native
event's `workflowName` labels logs. `createWorkflows` continues to wrap explicitly
supplied producer bindings. See the native [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/).

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
