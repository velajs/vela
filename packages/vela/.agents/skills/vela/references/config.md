# Configuration

`ConfigModule`, `ConfigService`, `registerAs`, `ConfigType`, `ConfigShape`, `ENV`, `InjectEnv`, and `VelaEnv` are exported from `@velajs/vela`. Environment input is the framework-owned `ENV` (`InjectionToken<VelaEnv>`): the bindings, variables, and secrets a runtime hands the application. On Workers, `@velajs/cloudflare` seeds it with the native environment before factories and lifecycle hooks run and types `VelaEnv` from the `Cloudflare.Env` that `wrangler types` generates.

## Typed namespaces

```ts
import { ConfigModule, Inject, Injectable, Module, registerAs, type ConfigType } from '@velajs/vela';

// env is the application's ENV; on Workers DATABASE_URL is typed by worker-configuration.d.ts.
export const database = registerAs('database', (env) => ({ url: env.DATABASE_URL, pool: 10 }));

@Module({ imports: [ConfigModule.forRoot({ load: [database], isGlobal: true })] })
class AppModule {}

@Injectable()
class DatabaseClient {
  constructor(@Inject(database.KEY) readonly config: ConfigType<typeof database>) {}
}
```

`registerAs(namespace, factory)` passes the application's `ENV` to the factory; reading the namespace throws a clear error when no runtime seeded `ENV`. Validate each environment value the factory reads. Declare each namespace once and reuse its `KEY`; equal descriptions do not make separately created injection tokens identical. `app.get(database.KEY)` infers the resolved config. `ConfigModule.forFeature(database)` provides one namespace to the importing module (lazily) and merges it into the application's `ConfigService`. Loading the same namespace through `forRoot({ load })` and `forFeature()` shares one `KEY` provider, so its factory runs once. `ConfigShape<[typeof database, ...]>` maps several namespaces to one shape.

Seed `ENV` per runtime: `export default createCloudflareWorker(AppModule)` on Workers, `VelaFactory.create(AppModule, { env })` elsewhere (a Node entry may pass `process.env`), and `Test.createTestingModule(metadata, { env })` or `overrideProvider(ENV).useValue(env)` in tests. Outside Workers, declare what the runtime provides by augmenting the interface: `declare module '@velajs/vela' { interface VelaEnv { DATABASE_URL?: string } }`. Inject the whole environment with `@InjectEnv()`. `ENV` has no default; framework readers use `@Optional()` and ignore non-string values.

## Reading config

`ConfigService<T>` takes the config shape the reader declares, for example `ConfigService<ConfigShape<[typeof database]>>` in a constructor: `get`/`getOrThrow` then check dot paths (up to a fixed depth) and return the path's value type, and `get(path, default)` returns the non-optional type. Without `T`, `get(path, defaultValue?)` and `getOrThrow(path)` return `unknown`; use `parse(path, schema)` when the key is dynamic:

```ts
const config = app.get(ConfigService);
const name = config.parse('app.name', z.string());
const exists = config.has('app.name');
```

`getOrThrow` rejects missing paths; `getAll()` returns the declared shape. Dangerous prototype path segments are rejected. The declared `T` is not validated against the loaded values: it is a reader-side contract, so validate environment input in the namespace factories.

## Module options

- `config`: flat/nested values.
- `load`: declared namespaces. Structural: pass it next to a `forRootAsync` factory.
- `validate`: validator for flat config; `forRoot` applies it eagerly.
- `validateSchema`: parser for merged config, applied on first read.
- `isGlobal` and `key`: registration controls, never part of the options.

`forRootAsync({ imports, inject, useFactory, load? })` resolves factory arguments from the dependency tuple (a factory without parameters may omit `inject`). Its factory returns the other config options (`config`, `validate`, `validateSchema`); returning `load` fails bootstrap, because namespaces shape the module graph. There are no NestJS env-file/Joi options. Namespace factories are synchronous and their providers are materialized lazily.
