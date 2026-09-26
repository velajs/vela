# New Vela API scaffold

Start new Workers projects with the CLI; it writes exactly the setup below with
pinned, released versions:

```sh
pnpm dlx @velajs/cli@latest new my-api                                # minimal: one controller and service
pnpm dlx @velajs/cli@latest new my-api --template api --install --git # KV resource, queue, cron, specs
```

`--pm npm|yarn|bun` switches the package manager (pnpm by default, or the one
running the command). For live queries or WebSocket Durable Objects, start from
`apps/live-todo` instead.

## Build configuration

Dependencies: `@velajs/vela`, `@velajs/cloudflare`, `hono` (plus an application
schema library such as Zod 4.4+ for validated bodies). Development tools:
TypeScript, Wrangler, Vite 8, `@cloudflare/vite-plugin`, Vitest,
`@cloudflare/vitest-plugin`, `@cloudflare/workers-types`, `@velajs/cli` and
`@velajs/testing`. The scripts regenerate the binding types without
package-manager pre-scripts:

```json
{
  "type": "module",
  "scripts": {
    "dev": "wrangler types --include-runtime=false && vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "deploy": "vite build && wrangler deploy",
    "test": "vitest run",
    "types": "wrangler types --include-runtime=false",
    "typecheck": "wrangler types --include-runtime=false && tsc --noEmit"
  }
}
```

Decorator metadata requires a compiler that emits it. Vite 8 compiles with Oxc;
state its decorator options once and share them with Vitest:

```ts
// oxc.config.ts
import type { UserConfig } from 'vite';

export const oxc = {
  decorator: { legacy: true, emitDecoratorMetadata: true },
} satisfies UserConfig['oxc'];
```

```ts
// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { oxc } from './oxc.config.ts';

export default defineConfig({ oxc, plugins: [cloudflare()] });
```

```ts
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

Point Wrangler at the TypeScript entry; Vite builds it, so there is no `build`
block. From compatibility date 2026-08-04 Node.js compatibility (and the
`node:async_hooks` the root entry imports) is on by default; older dates need
`"compatibility_flags": ["nodejs_als"]`:

```jsonc
{
  "name": "my-api",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-20",
}
```

Add native bindings to the Wrangler configuration (or let `vela add` do it),
then run the `types` script: `wrangler types --include-runtime=false` writes
`worker-configuration.d.ts`, whose `Cloudflare.Env` `@velajs/cloudflare` merges
into `VelaEnv`. Commit it. Vela includes its metadata polyfill; no separate
`reflect-metadata` dependency is needed. Deploy with the `deploy` script (never
`wrangler deploy --config wrangler.jsonc`, which bundles `src/` with esbuild and
drops decorator metadata).

## Source

```ts
// src/app.module.ts
import { Controller, Get, Injectable, Module } from '@velajs/vela';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello from Vela!';
  }
}

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

@Module({ controllers: [AppController], providers: [AppService] })
export class AppModule {}
```

```ts
// src/worker.ts: exports only.
import { createCloudflareWorker } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';

export default createCloudflareWorker(AppModule);
```

The framework owns the environment token: inject bindings with `@InjectEnv()`
typed as `VelaEnv`, or `ENV` in factories:
`defineProvider(TOKEN, { inject: [ENV], useFactory: env => ... })`; a factory
without parameters may omit `inject`.

A workerd spec builds the module as the Worker does and drives its handlers:

```ts
// test/worker.spec.ts
import { env } from 'cloudflare:workers';
import { createTestingWorker } from '@velajs/cloudflare/testing';
import { expect, it } from 'vitest';
import { AppModule, AppService } from '../src/app.module.js';

it('serves / with a replaced service', async () => {
  const worker = await createTestingWorker(AppModule, {
    env,
    overrides: (module) =>
      module.overrideProvider(AppService).useValue({ getHello: () => 'Hello from a test!' }),
  });
  try {
    const response = await worker.fetch('/');
    expect(await response.json()).toEqual({ message: 'Hello from a test!' });
  } finally {
    await worker.close();
  }
});
```

For a platform-neutral application use `await VelaFactory.create(AppModule)`
and export its fetch handler. Node uses `serve({ fetch: app.fetch })` from
`@hono/node-server`; keep that runtime-specific server entry separate from the
Worker entry.

## Growing the application

The CLI reads Wrangler's `main`, loads the `createCloudflareWorker()` entry
through Vite (decorators and metadata included, `cloudflare:*` stubbed) and
needs no configuration file:

```sh
pnpm exec vela generate resource notes     # module + controller + service, imported into AppModule
pnpm exec vela g queue emails              # @Processor + QueueModule.forFeature([]), driver once
pnpm exec vela g cron digest --schedule "0 6 * * *"
pnpm exec vela g durable-object counter    # exported from the Worker entry
pnpm exec vela add d1 DB                   # wrangler d1 create --binding DB --update-config, types, provider
pnpm exec vela cf sync --write             # triggers, queues, DO bindings + migrations, workflows
pnpm exec vela deploy check                # top-level target; the entrypoint snapshot is computed
```

Run `vela route list` and `vela openapi dump` to inspect the contract, then
`vela client generate --out src/api.generated.ts --strict`. The frontend imports
only the generated `AppType` and Hono `hc` from `@velajs/client/http`. Add a
`vela.config.ts` only when the tools need an application built differently (for
example with Wrangler's local bindings); see `references/cli-and-introspection.md`,
`references/openapi.md`, `references/cloudflare.md`, and
`references/live-queries.md`.
