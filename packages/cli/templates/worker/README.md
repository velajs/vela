# __PROJECT_NAME__

A small Vela API running on Cloudflare Workers. Requires Node.js 24+ and
pnpm 11.11.0. Local development needs no Cloudflare login or external services.

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm dev
```

In another terminal:

```sh
curl http://localhost:8787
# {"message":"Hello from Vela!"}
```

`src/app.module.ts` registers the controller and service. Vela injects
`AppService` into `AppController` through its constructor; the service supplies
the response message. `src/worker.ts` connects the module to Workers and keeps
application construction scoped to the Workers environment.

`pnpm build` compiles TypeScript into `dist/` with SWC, including the legacy
decorator metadata needed for constructor injection. `pnpm typecheck` checks
types separately. Wrangler runs the build on startup and rebuilds when `src/`
or `.swcrc` changes. Edit the service message and refresh to try it.

`pnpm dev --port 8788` uses a different local port. Stop with Ctrl-C.
Commit the generated `pnpm-lock.yaml` to keep dependency resolution repeatable.

The included `vela.config.mjs` imports the SWC-built application for Node-side
CLI tools. After `pnpm build`, inspect it with:

```sh
pnpm dlx @velajs/cli@latest doctor --app --json
pnpm dlx @velajs/cli@latest route list
```

`doctor` without `--app` only explains which config file would be used. With
`--app`, it runs the app's normal startup/shutdown hooks and reads graph
descriptions. Node's native TypeScript stripping does not emit decorators or DI
metadata, so keep the config pointed at `dist/` rather than decorated `src/`
files. If you add Workers bindings, provide their local equivalents in this
config; the Worker entrypoint and its environment remain separate.

To deploy later, authenticate with `pnpm exec wrangler login` and run
`pnpm run deploy`. Deployment uses your Cloudflare account; it is optional for
local development.

See the [Vela guides](https://github.com/velajs/vela/tree/main/docs) for modules,
controllers, dependency injection, and optional integrations.
