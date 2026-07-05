# New Vela project scaffold

A minimal, compilable starting point. Vela is edge-native: the app's `default` export is a `{ fetch }` handler that runs on Cloudflare Workers, Deno, Bun, and Node.

## `package.json`

```json
{
  "name": "my-vela-app",
  "type": "module",
  "scripts": {
    "build": "rm -rf dist && swc src -d dist --strip-leading-paths && tsc --emitDeclarationOnly",
    "dev": "pnpm run build && node dist/main.js",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@velajs/vela": "^1.15.0",
    "hono": "^4",
    "zod": "^4"
  },
  "devDependencies": {
    "@swc/cli": "^0.8.0",
    "@swc/core": "^1.15",
    "@types/node": "^22",
    "typescript": "^5"
  }
}
```

For a Node dev server also add `@hono/node-server`. For Cloudflare, add `@velajs/cloudflare` + `wrangler` and a `wrangler.toml` (see the `cloudflare.md` reference).

## `tsconfig.json`

Decorators require **both** `experimentalDecorators` and `emitDecoratorMetadata` (the latter powers constructor auto-injection):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "lib": ["ES2022"]
  },
  "include": ["src/**/*.ts"]
}
```

Vela ships its own `reflect-metadata` polyfill (imported by the main entry) — you do **not** need an external `reflect-metadata` dependency.

## `src/app.service.ts`

```ts
import { Injectable } from '@velajs/vela';

@Injectable()
export class AppService {
  getHello() {
    return { message: 'Hello from the edge!' };
  }
}
```

## `src/app.controller.ts`

```ts
import { Controller, Get } from '@velajs/vela';
import { AppService } from './app.service.js';

@Controller('/app')
export class AppController {
  constructor(private readonly appService: AppService) {}   // class dep → auto-injected

  @Get('/')
  hello() {
    return this.appService.getHello();
  }
}
```

## `src/app.module.ts`

```ts
import { Module } from '@velajs/vela';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

@Module({
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

## `src/main.ts`

```ts
import { VelaFactory } from '@velajs/vela';
import { AppModule } from './app.module.js';

const app = await VelaFactory.create(AppModule, { globalPrefix: '/api' });

// Edge runtimes (Cloudflare Workers, Deno, Bun) use the default { fetch } export:
export default app;
```

For a Node dev server, replace the export with `@hono/node-server`:

```ts
import { serve } from '@hono/node-server';
serve({ fetch: app.fetch, port: 8787 });
```

## `vela.config.ts` (optional — for the `@velajs/cli`)

Only needed if you use the `vela` CLI (`vela route list`, `vela module graph`, `vela openapi dump`, `vela db seed`):

```ts
import { defineVelaConfig } from '@velajs/cli/config';
import { VelaFactory } from '@velajs/vela';
import { AppModule } from './src/app.module.js';

export default defineVelaConfig({
  rootModule: AppModule,          // needed by `vela openapi dump`
  async createApp() {
    return VelaFactory.create(AppModule, { globalPrefix: '/api' });
  },
});
```
