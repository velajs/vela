# __PROJECT_NAME__

A small Vela API running on Cloudflare Workers. Requires Node.js 24+. Local
development needs no Cloudflare login or external services.

```sh
__INSTALL__
__RUN__ dev
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
separate compile step. `__RUN__ dev` serves the Worker in the local Workers
runtime and reloads it when `src/` changes. `__RUN__ build` writes the deployable
Worker to `dist/`, and `__RUN__ preview` serves that build.

Constructor injection needs legacy decorators and the `design:paramtypes`
metadata they record. Vite compiles TypeScript with Oxc, and `oxc.config.ts`
turns both on; `vite.config.ts` and `vitest.config.ts` import that one setting.
Import the classes you inject with a plain `import { AppService }`, not
`import type`: the metadata needs a runtime value.

`__RUN__ test` runs `test/` inside the Workers runtime with
`@cloudflare/vitest-plugin`. The spec builds `AppModule` with
`createTestingWorker()` from `@velajs/cloudflare/testing`, exactly as
`src/worker.ts` does, sends requests through the Worker's `fetch` handler, and
replaces a provider with `overrides`. `__RUN__ typecheck` checks the
application, tests and config files with TypeScript.

## Environment

The Workers environment is available to providers as `ENV` from `@velajs/vela`:
`constructor(@InjectEnv() env: VelaEnv)`, or `inject: [ENV]` in a factory.
`__RUN__ types` runs `wrangler types --include-runtime=false`, which writes the
bindings and variables declared in `wrangler.jsonc`, plus the secret names in
`.dev.vars`, to `worker-configuration.d.ts`; `VelaEnv` picks them up from there.
`__RUN__ dev` and `__RUN__ typecheck` regenerate the file first. Commit it, and
validate each value your code reads, since it comes from outside the program.

## Grow the application

`@velajs/cli` is a dev dependency. It reads `main` from `wrangler.jsonc` and
loads the application `src/worker.ts` exports through Vite, with the same
decorator settings as the Worker build, so there is nothing to configure:

```sh
__EXEC__ vela route list
__EXEC__ vela generate resource notes     # module, controller and service, registered in AppModule
__EXEC__ vela generate cron cleanup       # an @Cron job
__EXEC__ vela add kv CACHE                # creates a KV namespace and adds the binding
__EXEC__ vela cf sync                     # compares wrangler.jsonc with the app's crons, queues and Durable Objects
```

`vela cf sync --write` updates `wrangler.jsonc` in place, keeping its comments.
Listing commands build the application with the `vars` of `wrangler.jsonc`
only, never your bindings or secrets.

## Deploy

To deploy, authenticate with `__EXEC__ wrangler login` and run
`__RUN__ deploy`, which builds with Vite and uploads `dist/` with Wrangler.
Deployment uses your Cloudflare account; it is optional for local development.
`__EXEC__ vela deploy check` compares `wrangler.jsonc` with the application
before you deploy. `__RUN__ build` also copies `.dev.vars` into `dist/` for
`__RUN__ preview`. Wrangler does not upload it, and `dist/` is git-ignored; do
not publish `dist/` any other way while it holds local secrets.

Commit the lockfile your package manager writes to keep dependency resolution
repeatable. See the [Vela guides](https://github.com/velajs/vela/tree/main/docs)
for modules, controllers, dependency injection, and optional integrations.
