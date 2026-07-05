# Configuration (`ConfigModule`, `registerAs`)

`ConfigModule`, `ConfigService`, `registerAs`, `ConfigType`, `CONFIG_ENV` are all on the main export `@velajs/vela`. Core never touches `process.env` (edge-runtime rule) — environment values enter through the `CONFIG_ENV` token, seeded by the runtime adapter.

## ConfigModule.forRoot

```ts
import { ConfigModule } from '@velajs/vela';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      config: {
        app: { name: 'evergreen-market', port: 8787 },
        features: { examples: true },
      },
    }),
  ],
})
class AppModule {}
```

`ConfigModuleOptions` — the complete field set (there is no `cache`, `expandVariables`, `envFilePath`, or Joi `validationSchema`; the NestJS env-file options do not exist):

| Field | Type | Notes |
|---|---|---|
| `config` | `Record<string, unknown>` | Flat/nested config record. Read via dot-notation. |
| `load` | `AnyConfigNamespace[]` | Namespaces from `registerAs()`. **`forRoot`-only.** |
| `validate` | `(config) => config` | Eager validator for the flat `config`; runs at `forRoot()` call time (fail-fast), then is stripped. |
| `validateSchema` | `ConfigSchema` | Validates the MERGED config (flat + namespaces); runs lazily on first read. **`forRoot`-only.** Accepts a Zod schema or any `{ parse }` (structural — zod stays optional). |
| `isGlobal` | `boolean` | Export config app-wide. |
| `key` | `string` | **Not a base `ConfigModuleOptions` field** — a `forRoot`/`forRootAsync` signature extra that discriminates multiple instances. |

## Reading config — typed dot-notation

Inject `ConfigService` anywhere. `get` supports typed dot-paths into nested objects:

```ts
@Injectable()
class ProductService {
  constructor(private readonly config: ConfigService) {}

  create() {
    const name = this.config.get('app.name');            // string | undefined
    const port = this.config.get('app.port', 3000);      // default when missing
    const enabled = this.config.getOrThrow('features.examples'); // throws if absent
    const present = this.config.has('app.name');         // boolean
  }
}
```

`ConfigService` methods: `get(path)`, `get(path, default)`, `getOrThrow(path)`, `has(path)`, `getAll()`. Type the store for full path/return inference:

```ts
const cfg = app.get(ConfigService) as ConfigService<{ app: { name: string } }>;
cfg.getOrThrow('app.name'); // typed string
```

`__proto__` / `constructor` / `prototype` path segments are guarded and return `undefined`.

## Config namespaces — `registerAs`

`registerAs(namespace, factory)` groups related config under a key. The factory receives the **`env` record** (from `CONFIG_ENV`), unlike NestJS where the factory reads `process.env` itself:

```ts
import { registerAs, ConfigModule, ConfigService, ConfigType, InferConfigType, CONFIG_ENV } from '@velajs/vela';

const dbConfig = registerAs('database', (env: { DATABASE_URL?: string }) => ({
  url: env.DATABASE_URL ?? 'sqlite::memory:',
  pool: 10,
}));

const mailConfig = registerAs('mail', (env: { MAIL_FROM?: string }) => ({
  from: env.MAIL_FROM ?? 'noreply@example.com',
}));

@Module({
  imports: [ConfigModule.forRoot({ load: [dbConfig, mailConfig], isGlobal: true })],
})
class AppModule {}
```

Namespaces merge under their name, so `cfg.get('database.url')` and `cfg.get('mail.from')` resolve. Three ways to consume a namespace:

```ts
// 1. Inject the namespace token directly (its config shape is typed)
@Injectable()
class DbClient {
  constructor(@Inject(dbConfig.KEY) readonly db: InferConfigType<typeof dbConfig>) {}
}

// 2. Read through ConfigService with dot-notation
cfg.get('database.url');

// 3. Type the whole service from a tuple of namespaces
const typed = app.get(ConfigService) as ConfigService<ConfigType<[typeof dbConfig, typeof mailConfig]>>;
typed.getOrThrow('database.pool'); // number
```

`ConfigType<[...]>` takes a **tuple** of namespaces → the merged shape. `InferConfigType<typeof ns>` extracts a single namespace's shape. Each namespace's `KEY` is `Symbol.for('vela:config:<namespace>')` (HMR-stable).

## Seeding `CONFIG_ENV`

`CONFIG_ENV` self-provides `{}` by default. A platform adapter or a global module overrides it with the real environment — this is how `registerAs` factories get their `env`:

```ts
@Global()
@Module({
  providers: [{ provide: CONFIG_ENV, useValue: env }], // env = workerd binding, etc.
  exports: [CONFIG_ENV],
})
class EnvModule {}
```

On Cloudflare Workers the adapter seeds `CONFIG_ENV` from the workerd `env` binding, so `cfg.get('database.url')` reads through with no `process.env`.

## Async config — `forRootAsync`

```ts
ConfigModule.forRootAsync({
  imports: [/* modules exporting the injected deps */],
  inject: [SomeLoader],
  useFactory: async (loader: SomeLoader) => ({ config: await loader.load() }),
});
```

The factory returns `ConfigModuleOptions`. **Caveat:** on the async path only the flat `config` (and `validate`) are honored — `load` and `validateSchema` are `forRoot`-only, because they are read structurally at module-definition time before the async factory resolves. Declare namespaces via `forRoot`.

`ConfigModule` is eager (its `ConfigService`/`ConfigStore` construct at bootstrap), so a synchronous `app.get(ConfigService)` after `create()` returns the resolved singleton. Only the per-namespace providers defer (their factories read the possibly-per-request `CONFIG_ENV`).
