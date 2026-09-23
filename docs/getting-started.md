# Create a Workers API

Use Node.js 24+ and pnpm 11.11.0. Create a project with the Vela CLI:

```sh
pnpm dlx @velajs/cli@latest new my-api
cd my-api
pnpm install
pnpm dev
```

If the CLI is already installed, the creation command is `vela new my-api`.
The command writes files without installing dependencies or initializing Git.
Use a name starting with a lowercase letter, followed by lowercase letters,
digits, or single hyphens, up to 63 characters. Run it from the parent directory;
paths, scoped package names, and reserved device names are rejected. An existing
destination must be an empty directory; files, symbolic links, and nonempty
directories are left untouched. There is no overwrite option.

In another terminal, request the API:

```sh
curl http://localhost:5173
# {"message":"Hello from Vela!"}
```

`pnpm dev` runs `vite dev`: Vite and `@cloudflare/vite-plugin` serve
`src/worker.ts` in the local Workers runtime, with no build step first. No
Cloudflare login, database, authentication setup, Studio, or live-query service
is required. Use `pnpm dev --port 5174` if port 5173 is occupied.

## Understand the application

The generated project has four source files:

| File | Responsibility |
| --- | --- |
| `src/app.module.ts` | Registers the controller and service. |
| `src/app.controller.ts` | Handles `GET /` and calls its injected service. |
| `src/app.service.ts` | Supplies the greeting through an injectable class. |
| `src/worker.ts` | `export default createCloudflareWorker(AppModule)`: one application per native Workers environment. |

The controller receives `AppService` through constructor injection:

```ts
import { Controller, Get } from '@velajs/vela';
import { AppService } from './app.service.js';

@Controller('/')
export class AppController {
  readonly #appService: AppService;

  constructor(appService: AppService) {
    this.#appService = appService;
  }

  @Get()
  getHello() {
    return { message: this.#appService.getHello() };
  }
}
```

`AppService` is imported as a value, not with `import type`: the constructor
parameter metadata refers to the class at runtime. The project's `tsconfig.json`
enables `verbatimModuleSyntax` and `isolatedModules`, so TypeScript keeps exactly
the imports you write and flags a type-only name imported as a value.

Edit the message in `AppService` and repeat the request: the dev server reloads
the Worker when `src/` changes. Vite compiles TypeScript with Oxc. Constructor
injection needs legacy decorators and the `design:paramtypes` metadata they
record, and Oxc emits both only when asked, so `oxc.config.ts` enables them and
both `vite.config.ts` and `vitest.config.ts` import that one setting. TypeScript
checks the source separately with `pnpm typecheck`.

`wrangler.jsonc` points `main` at `src/worker.ts`; Vite builds it, so there is
no Wrangler `build` block. Its compatibility date, 2026-09-20, enables Node.js
compatibility by default (from 2026-08-04 on), which provides the
`node:async_hooks` module that Vela's root entry imports. With an older date, add
`"compatibility_flags": ["nodejs_als"]`.

## Test the Worker

`pnpm test` runs `test/worker.spec.ts` inside the Workers runtime with
`@cloudflare/vitest-plugin`. The spec calls the Worker's `fetch` handler and
reads the response body before `waitOnExecutionContext(ctx)`, since a request
completes only once its body is consumed:

```ts
const ctx = createExecutionContext();
const response = await worker.fetch(new Request('http://localhost/'), env, ctx);
const body = await response.json();
await waitOnExecutionContext(ctx);
expect(body).toEqual({ message: 'Hello from Vela!' });
```

## Read bindings

The native Workers environment is the framework `ENV`. The worker entry needs no
environment token: `createCloudflareWorker` seeds `ENV` for each environment
before any provider is constructed. Declare a binding or variable in
`wrangler.jsonc`, run `pnpm types`, and inject it:

```jsonc
// wrangler.jsonc
"vars": { "GREETING": "Hello from a variable!" }
```

```ts
import { Injectable, InjectEnv, type VelaEnv } from '@velajs/vela';

@Injectable()
export class AppService {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  getHello(): string {
    return this.env.GREETING;
  }
}
```

`pnpm types` runs `wrangler types --include-runtime=false`, which writes the
bindings, variables and secret names (from `.dev.vars`) into
`worker-configuration.d.ts` as `Cloudflare.Env`. `@velajs/cloudflare` extends
`VelaEnv` with it, so `this.env.GREETING` is typed. `pnpm dev` and
`pnpm typecheck` regenerate the file first; run `pnpm types` yourself after
editing `wrangler.jsonc`, and commit the file. Runtime types still come
from `@cloudflare/workers-types`. Factories read the same object with
`inject: [ENV]`, and `registerAs('app', (env) => ...)` config namespaces receive
it too. Values arrive from outside the program, so validate what you read.

Wrangler secrets such as `URL_SIGNING_SECRET` (signed URLs) and
`VELA_STUDIO_TOKEN` (Studio) are part of `ENV` as well and take effect once set.

## Inspect the application

The project pins `@velajs/cli` as a dev dependency and includes
`vela.config.ts`, which imports the application from `src/`. The CLI loads the
config through Vite with the same Oxc decorator settings as the Worker build, so
no build is needed first:

```sh
pnpm vela route list
pnpm vela doctor --app --json
```

Dependencies use pinned published npm versions. The generated
`pnpm-workspace.yaml` allows the native build dependencies used by Wrangler and
the Workers runtime; it has no dependency catalog or repository links. Commit
the lockfile created by `pnpm install`.

## Next steps

To deploy, run `pnpm exec wrangler login` and then `pnpm run deploy`. This requires
your Cloudflare account; it runs `vite build`, then `wrangler deploy` uploads the
built Worker from `dist/`. See [deployment](deployment.md).

Continue with [module authoring](modules.md), [runtime values and types](types.md),
and [Cloudflare integration](../packages/cloudflare/README.md) when adding routes
or native bindings. The [complete API starter](../apps/api-starter/README.md)
demonstrates authentication, D1, generated clients, live queries, and Studio.

`vela new` currently creates this one Workers starter. Module, controller,
service, and resource generators are follow-up work.
