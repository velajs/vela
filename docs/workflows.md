# Workflows

A Vela Workflow is a Cloudflare Workflow class (a `WorkflowEntrypoint`) whose
`run(event, step)` is the `run` method of an `@Injectable()` host. Each run
executes in the Worker's own application for its environment, the one the
Worker's `fetch`, `queue` and `scheduled` handlers use, through the host's
guards, interceptors and exception filters.

## Define a Workflow

```ts
// src/signup/signup.host.ts
import { Injectable } from '@velajs/vela';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { UsersService } from '../users/users.service.js';

export interface SignupParams {
  email: string;
}

@Injectable()
export class SignupHost {
  constructor(private readonly users: UsersService) {}

  async run(event: WorkflowEvent<SignupParams>, step: WorkflowStep): Promise<{ userId: string }> {
    const user = await step.do('create user', () => this.users.create(event.payload.email));
    await step.sleep('grace period', '1 day');
    await step.do('send welcome', { retries: { limit: 3, delay: '1 minute' } }, () =>
      this.users.welcome(user.id),
    );
    return { userId: user.id };
  }
}
```

```ts
// src/worker.ts
import { defineCloudflareApp } from '@velajs/cloudflare';
import { VelaWorkflow } from '@velajs/cloudflare/workflows';
import { AppModule } from './app.module.js';
import { SignupHost } from './signup/signup.host.js';

const app = defineCloudflareApp(AppModule);

export class SignupWorkflow extends VelaWorkflow(app, SignupHost) {}
export default app.worker;
```

- `VelaWorkflow(app, Host)` takes the app from `defineCloudflareApp`: the
  Workflow runs in the application that app builds, so it shares its
  singletons, its runtime adapters and its `ENV`. A bare root module is
  rejected.
- The host is added to the root module's providers, so it injects what the
  root module can see: its providers, its imports' exports, global tokens and
  `ENV`. Do not list it in a module yourself.
- Declare the class at module scope of the module that defines the app, as for
  [Durable Objects](durable-objects.md#one-app-definition). Hosts are added
  when the Worker builds its application, so a class defined after the first
  event throws.
- The host must declare `run` in its class body (not as an arrow-function
  field). A host whose prototype defines `then()` is rejected: every instance
  would be a thenable, and resolving it would hang.

Bind the class under `workflows` in Wrangler (`vela cf sync --write` adds
`{ name, binding, class_name }` for every exported Workflow class) and
regenerate the environment types. `wrangler types` types the binding from the
exported class's `run`, so `ENV.SIGNUP_WORKFLOW` is a
`Workflow<Readonly<SignupParams>>`.

## Start instances

From any provider, read the binding from `ENV`:

```ts
@Injectable()
export class SignupService {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  async start(email: string): Promise<string> {
    const instance = await this.env.SIGNUP_WORKFLOW.create({ params: { email } });
    return instance.id;
  }
}
```

Module options and shared helpers can name the binding instead of holding it,
with the typed `workflow({ binding })` reference from `@velajs/cloudflare`:

```ts
import { workflow } from '@velajs/cloudflare';
import type { WorkflowParams } from '@velajs/cloudflare/workflows';

const signups = workflow<WorkflowParams<SignupWorkflow>>({ binding: 'SIGNUP_WORKFLOW' });
// Later, with an application's ENV:
await signups(env).create({ id: 'signup-42', params: { email } });
```

`WorkflowParams<T>` reads the params from a Workflow class or its host. The
reference resolves and checks the binding when it is called, and fails naming
the binding and the `workflows` key when it is missing.

## Runs, steps and scopes

- `event` and `step` are the engine's own objects, passed to the host
  untouched: `step.do`, `step.sleep`, `step.sleepUntil` and `step.waitForEvent`
  keep their retry, timeout and replay semantics.
- The engine may call `run()` again for the same instance, after a sleep, an
  event or an eviction; completed steps then return their stored results. Each
  call is a new run: it builds its own execution scope, so request-scoped
  providers are built per run, and guards and interceptors run again. Keep side
  effects inside `step.do`.
- `EXECUTION_LIFETIME` work (`defer`, `waitUntil`) settles before the run
  returns; a failure of that work is reported and does not fail the run.

## The pipeline

Guards, interceptors and exception filters declared on the host class or its
`run` method (`@UseGuards`, `@UseInterceptors`, `@UseFilters`) run around every
run. Application-wide `APP_*` components do not apply. The `ExecutionContext`
reports `getType()` `'cf:workflow'` (`WorkflowExecutionContext`), `getClass()`
the host, `getHandler()` its `run`, and `getPayload()` the event. A guard that
returns `false` fails the run with a `ForbiddenException`. Pipes do not run:
validate `event.payload` in the host, which receives it from whoever created
the instance.

## Errors

A failure is reported first, through the application's `ExceptionHandler`
(`edge: 'workflow'`, `source: 'SignupHost.run'`, `kind: 'cf:workflow'`), then
rethrown as it is, so the engine applies its own semantics: a
`NonRetryableError` from `cloudflare:workflows` ends the instance, and an error
thrown by a step callback that exhausted its retries fails it. A scoped
exception filter that catches the error settles the run with what the filter
returns instead.

The engine also throws into a run to interrupt it: when an instance is paused,
restarted or terminated, `step.do`, `step.sleep` and a retry wait reject with
an `Error` whose message starts with `Aborting engine:`. That is not a failure
of the run, so it passes through as it is: it is not reported and no exception
filter sees it, and the engine pauses, restarts or ends the instance. An
interceptor that catches errors must rethrow it too.

Errors raised inside a `step.do` callback are the engine's to retry; the
application sees only what escapes `run`.

## Tests

In workerd with `@cloudflare/vitest-plugin`, drive a real instance with
`introspectWorkflowInstance` from `cloudflare:test`:

```ts
import { introspectWorkflowInstance } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

const instance = await introspectWorkflowInstance(env.SIGNUP_WORKFLOW, 'signup-1');
try {
  await instance.modify(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  await env.SIGNUP_WORKFLOW.create({ id: 'signup-1', params: { email: 'ada@example.com' } });
  await instance.waitForStatus('complete');
  expect(await instance.getOutput()).toEqual({ userId: expect.any(String) });
} finally {
  await instance.dispose();
}
```

## Tooling

- `vela g workflow signup` writes `signup.host.ts` and declares
  `export class Signup extends VelaWorkflow(app, SignupHost) {}` in the Worker
  entry, after its app. An entry that default-exports
  `createCloudflareWorker(AppModule, options)` gets
  `const app = defineCloudflareApp(AppModule, options)` first; an entry that
  imports its app from its own module gets `signup.workflow.ts`, exported from
  the entry.
- `vela cf sync --write` declares a `workflows` entry for every exported
  Workflow class, and warns about a Workflow class the app defines that the
  entry does not export.
- `vela entrypoint list` lists exported Vela Workflow classes as `cf:workflow`
  rows, and `vela deploy check` warns with `unbound-workflow` and
  `unexported-workflow` (see [deployment](deployment.md)).

For portable workflow definitions shared with other execution adapters, see
[`@velajs/workflow`](../packages/workflow/README.md).
