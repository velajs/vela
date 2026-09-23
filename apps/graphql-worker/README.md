# GraphQL Worker

A native Worker example using `@velajs/graphql`, Yoga, Zod validation, request-scoped DI, an injected environment binding and an operation-owned cache. No `nodejs_compat` flag is required.

From the repository root, after installing and building workspace dependencies:

```sh
pnpm --filter graphql-worker dev
```

```sh
curl http://localhost:8787/graphql \
  -H 'content-type: application/json' \
  --data '{"query":"{ a:greet(name: \"Vela\") b:greet(name: \"Vela\") }"}'
```

Set `APP_LABEL` in `wrangler.toml`. The resolver reads it from the framework `ENV` (`InjectEnv()`), typed by the `worker-configuration.d.ts` that `pnpm --filter graphql-worker types` regenerates with `wrangler types`. Both aliases share one cache for this operation. This public greeting endpoint has no authentication; use the HTTP auth/tenant pipeline and field permission guards for protected data. See the [package guide](../../packages/graphql/README.md).

Run `pnpm --filter @velajs/graphql test:workers` for the native-runtime test of this example.
