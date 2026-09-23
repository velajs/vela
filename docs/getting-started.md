# Create a Workers API

Use Node.js 24+ and pnpm 11.11.0. Create a project with the Vela CLI:

```sh
pnpm dlx @velajs/cli@latest new my-api
cd my-api
pnpm install
pnpm typecheck
pnpm build
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
curl http://localhost:8787
# {"message":"Hello from Vela!"}
```

Local development uses Wrangler's local Workers runtime. No Cloudflare login,
database, authentication setup, Studio, or live-query service is required.
Use `pnpm dev --port 8788` if port 8787 is occupied.

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
// Keep the runtime import for SWC's constructor metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
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
parameter metadata that SWC emits refers to the class at runtime.

Edit the message in `AppService` and repeat the request. Wrangler reruns the SWC
build when `src/` or `.swcrc` changes, and the response reflects the new service
code. SWC's `.swcrc` enables legacy decorators and constructor parameter metadata;
TypeScript checks the source separately. `wrangler.jsonc` points to compiled
JavaScript so Wrangler does not have to infer decorator metadata. Its
`nodejs_compat` flag provides the `node:async_hooks` module that Vela's root
entry imports; the flag is also on by default from compatibility date 2026-08-04.

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
`pnpm typecheck` regenerate the file first; commit it. Runtime types still come
from `@cloudflare/workers-types`. Factories read the same object with
`inject: [ENV]`, and `registerAs('app', (env) => ...)` config namespaces receive
it too. Values arrive from outside the program, so validate what you read.

Wrangler secrets such as `URL_SIGNING_SECRET` (signed URLs) and
`VELA_STUDIO_TOKEN` (Studio) are part of `ENV` as well and take effect once set.

## Inspect the application

The project also includes `vela.config.mjs`, which loads the compiled
application from `dist/` for Node-side CLI tools. After `pnpm build`, inspect
the routes with `pnpm dlx @velajs/cli@latest route list`.

Dependencies use pinned published npm versions. The generated
`pnpm-workspace.yaml` allows the native build dependencies used by SWC and
Wrangler; it has no dependency catalog or repository links. Commit the lockfile
created by `pnpm install`.

## Next steps

To deploy, run `pnpm exec wrangler login` and then `pnpm run deploy`. This requires
your Cloudflare account and rebuilds the Worker before publishing it.

Continue with [module authoring](modules.md), [runtime values and types](types.md),
and [Cloudflare integration](../packages/cloudflare/README.md) when adding routes
or native bindings. The [complete API starter](../apps/api-starter/README.md)
demonstrates authentication, D1, generated clients, live queries, and Studio.

`vela new` currently creates this one Workers starter. Module, controller,
service, and resource generators are follow-up work.
