# New Vela API scaffold

Use the workspace's aligned Vela/Hono versions. For Workers, start with `apps/live-todo` when live queries or Durable Objects are required; the small HTTP-only shape below needs no binding wrapper modules.

## Build configuration

Install `@velajs/vela`, `@velajs/cloudflare`, `hono`, and an application schema library such as Zod 4.4+. Add TypeScript, Wrangler, Vite 8, `@cloudflare/vite-plugin`, Vitest, `@cloudflare/vitest-plugin`, `@cloudflare/workers-types` and `@velajs/cli` as development tools. `vela new` generates exactly this setup. Preserve generated native Worker environment types from `wrangler types`.

Decorator metadata requires a compiler that emits it. Vite 8 compiles with Oxc; state its decorator options once and share them with Vitest:

```json
{
  "type": "module",
  "scripts": {
    "predev": "pnpm run types",
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "deploy": "vite build && wrangler deploy",
    "test": "vitest run",
    "types": "wrangler types --include-runtime=false",
    "pretypecheck": "pnpm run types",
    "typecheck": "tsc --noEmit"
  }
}
```

```ts
// oxc.config.ts
import type { UserConfig } from 'vite';
export const oxc = {
  decorator: { legacy: true, emitDecoratorMetadata: true },
} satisfies UserConfig['oxc'];

// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { oxc } from './oxc.config.ts';
export default defineConfig({ oxc, plugins: [cloudflare()] });

// vitest.config.ts: no cloudflare() here; the test pool replaces it.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { oxc } from './oxc.config.ts';
export default defineConfig({
  oxc,
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: { include: ['test/**/*.spec.ts'] },
});
```

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ES2024"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-plugin/types"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "*.config.ts", "worker-configuration.d.ts"]
}
```

Point Wrangler at the TypeScript entry; Vite builds it, so there is no `build` block. From compatibility date 2026-08-04 Node.js compatibility (and the `node:async_hooks` the root entry imports) is on by default; older dates need `"compatibility_flags": ["nodejs_als"]`:

```jsonc
{
  "name": "my-vela-api",
  "main": "src/main.ts",
  "compatibility_date": "2026-09-20",
}
```

Add native bindings to the Wrangler configuration, then run `pnpm types`: `wrangler types --include-runtime=false` writes `worker-configuration.d.ts`, whose `Cloudflare.Env` `@velajs/cloudflare` merges into `VelaEnv`. Commit it. Vela includes its metadata polyfill; no separate `reflect-metadata` dependency is needed. Deploy with `pnpm run deploy` (never `wrangler deploy --config wrangler.jsonc`, which bundles `src/` with esbuild and drops decorator metadata).

A workerd test calls the Worker's `fetch` handler and drains the body before waiting:

```ts
// test/main.spec.ts
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import worker from '../src/main.js';

it('serves /api/app', async () => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://localhost/api/app'), env, ctx);
  const body = await response.json();
  await waitOnExecutionContext(ctx);
  expect(body).toEqual({ message: 'Hello from Workers' });
});
```

## `src/app.module.ts`

```ts
import { Controller, Get, Module } from '@velajs/vela';
import { z } from 'zod';

const Hello = z.object({ message: z.string() });

@Controller('/app')
class AppController {
  @Get({ response: Hello })
  hello() {
    return { message: 'Hello from Workers' };
  }
}

@Module({ controllers: [AppController] })
export class AppModule {}
```

## `src/main.ts`

```ts
import { createCloudflareWorker } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';

export default createCloudflareWorker(AppModule, { globalPrefix: '/api' });
```

The framework owns the environment token: inject bindings with `@InjectEnv()` typed as `VelaEnv`, or `ENV` in factories: `defineProvider(TOKEN, { inject: [ENV], useFactory: env => ... })`; a factory without parameters may omit `inject`.

For a platform-neutral application use `await VelaFactory.create(AppModule)` and export its fetch handler. Node uses `serve({ fetch: app.fetch })` from `@hono/node-server`; keep that runtime-specific server entry separate from the Worker entry.

## Introspection and RPC

Install `@velajs/cli` as a dev dependency when introspection/codegen is needed and run it as `pnpm vela ...`. Its `vela.config.ts` uses `defineVelaConfig({ rootModule: AppModule, createApp })` from `@velajs/cli/config` and imports `./src/app.module.js` directly: with Vite 8 installed, the CLI loads it through a Vite module runner that stays open for the whole command, with the same Oxc decorator options, so nothing is built first. Make `createApp` construct the application with the appropriate test/tooling environment (`VelaFactory.create(AppModule, { env, adapters })`); never invent platform bindings with a type assertion.

Run `vela route list` and `vela openapi dump` to inspect the contract, then `vela client generate --out src/api.generated.ts --strict`. The frontend imports only the generated `AppType` and Hono `hc` from `@velajs/client/http`. See `references/openapi.md`, `references/cloudflare.md`, and `references/live-queries.md` for the complete wiring.
