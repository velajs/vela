# Configuration

`ConfigModule`, `ConfigService`, `registerAs`, and `InferConfigType` are exported from `@velajs/vela`. Environment input comes from a declared typed token. On Workers, the adapter registers the native environment before factories and lifecycle hooks run.

## Typed namespaces

```ts
import { ConfigModule, Inject, Injectable, InjectionToken, Module, registerAs, type InferConfigType } from '@velajs/vela';

interface WorkerEnv { DATABASE_URL: string }
export const ENV = new InjectionToken<WorkerEnv>('app.Env');
export const database = registerAs('database', ENV, (env) => ({ url: env.DATABASE_URL, pool: 10 }));

@Module({ imports: [ConfigModule.forRoot({ load: [database], isGlobal: true })] })
class AppModule {}

@Injectable()
class DatabaseClient {
  constructor(@Inject(database.KEY) readonly config: InferConfigType<typeof database>) {}
}
```

`registerAs(namespace, envToken, factory)` infers environment input from the token. Declare each namespace once and reuse its `KEY`; equal descriptions do not make separately created injection tokens identical. `app.get(database.KEY)` infers the resolved config. `ConfigType<[typeof database, ...]>` describes an aggregate shape but does not validate a runtime config service.

On Workers export `createCloudflareWorker(AppModule, { envToken: ENV })`. In tests or another runtime, provide that same token with `defineProvider(ENV, { useValue: actualEnv })` in an appropriately exported/global module. `CONFIG_ENV` remains a raw framework environment token; it does not prove an application's environment shape.

## Dynamic config paths

`ConfigService` is not generic. `get(path, defaultValue?)` and `getOrThrow(path)` return `unknown`; use `parse(path, schema)` when the key is dynamic:

```ts
const config = app.get(ConfigService);
const name = config.parse('app.name', z.string());
const exists = config.has('app.name');
```

`getOrThrow` rejects missing paths; `getAll()` returns `Record<string, unknown>`. Dangerous prototype path segments are rejected. Casting the service or choosing a read generic does not establish a config contract.

## Module options

- `config`: flat/nested values.
- `load`: declared namespaces; available on `forRoot`.
- `validate`: validator for flat config; `forRoot` applies it eagerly.
- `validateSchema`: parser for merged config; available on `forRoot`, applied on first read.
- `isGlobal` and `key`: module configuration extras.

`forRootAsync({ imports, inject, useFactory })` resolves factory arguments from the required dependency tuple (`inject: []` for no dependencies). Its factory returns config options, but structural `load`/`validateSchema` behavior must be declared through `forRoot`; async factories do not create those structural contributions. There are no NestJS env-file/Joi options. Namespace factories are synchronous and their providers are materialized lazily.
