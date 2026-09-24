# sample-api

A small Vela API running on Cloudflare Workers. Requires Node.js 24+ and
pnpm 11.11.0. Local development needs no Cloudflare login or external services.

```sh
pnpm install
pnpm dev
```

In another terminal:

```sh
curl http://localhost:5173
# {"message":"Hello from Vela!"}
```

`src/app.module.ts` registers the controller and service. Vela injects
`AppService` into `AppController` through its constructor; the service supplies
the response message. `src/worker.ts` only exports
`createCloudflareWorker(AppModule)`, which builds one application per Workers
environment. Edit the service message and refresh to see the change.

## Build and test

Vite and `@cloudflare/vite-plugin` run `src/worker.ts` directly: there is no
separate compile step. `pnpm dev` serves the Worker in the local Workers runtime
and reloads it when `src/` changes. `pnpm build` writes the deployable Worker to
`dist/`, and `pnpm preview` serves that build.

Constructor injection needs legacy decorators and the `design:paramtypes`
metadata they record. Vite compiles TypeScript with Oxc, and `oxc.config.ts`
turns both on; `vite.config.ts` and `vitest.config.ts` import that one setting.
Import the classes you inject with a plain `import { AppService }`, not
`import type`: the metadata needs a runtime value.

`pnpm test` runs `test/` inside the Workers runtime with `@cloudflare/vitest-plugin`.
The included spec calls the Worker's `fetch` handler and checks the response.
`pnpm typecheck` checks the application, tests and config files with TypeScript.

## Environment

The Workers environment is available to providers as `ENV` from `@velajs/vela`:
`constructor(@InjectEnv() env: VelaEnv)`, or `inject: [ENV]` in a factory.
`pnpm types` runs `wrangler types --include-runtime=false`, which writes the
bindings and variables declared in `wrangler.jsonc`, plus the secret names in
`.dev.vars`, to `worker-configuration.d.ts`; `VelaEnv` picks them up from there.
`pnpm dev` regenerates the file first. Commit it, run `pnpm types` after editing
`wrangler.jsonc`, and validate each value your code reads, since it comes from
outside the program.

## Inspect the application

`@velajs/cli` is a dev dependency. `vela.config.ts` imports the application
source; the CLI loads it through Vite with the same decorator settings as the
Worker build, so no build is needed first:

```sh
pnpm vela doctor --app --json
pnpm vela route list
```

`doctor` without `--app` only explains which config file would be used. With
`--app`, it runs the app's normal startup/shutdown hooks and reads graph
descriptions. The config runs in Node, separate from the Worker entrypoint and
its environment. If you add Workers bindings, provide local equivalents in the
config with `VelaFactory.create(AppModule, { env })`.

## Deploy

To deploy, authenticate with `pnpm exec wrangler login` and run
`pnpm run deploy`, which builds with Vite and uploads `dist/` with Wrangler.
Deployment uses your Cloudflare account; it is optional for local development.
`pnpm build` also copies `.dev.vars` into `dist/` for `pnpm preview`. Wrangler
does not upload it, and `dist/` is git-ignored; do not publish `dist/` any other
way while it holds local secrets.

Commit the generated `pnpm-lock.yaml` to keep dependency resolution repeatable.
See the [Vela guides](https://github.com/velajs/vela/tree/main/docs) for modules,
controllers, dependency injection, and optional integrations.
