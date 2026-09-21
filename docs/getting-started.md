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
| `src/worker.ts` | Exports Workers handlers with application initialization scoped to the native environment. |

The controller uses ordinary constructor injection:

```ts
@Controller('/')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello() {
    return { message: this.appService.getHello() };
  }
}
```

Edit the message in `AppService` and repeat the request. Wrangler reruns the SWC
build when source files change, and the response reflects the new service code.
SWC's `.swcrc` enables legacy decorators and constructor parameter metadata;
TypeScript checks the source separately. `wrangler.jsonc` points to compiled
JavaScript so Wrangler does not have to infer decorator metadata.

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
