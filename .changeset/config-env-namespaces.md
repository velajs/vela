---
"@velajs/vela": minor
---

Bring config namespaces to the NestJS shape. `ConfigModule.forFeature(namespace)` provides one `registerAs` namespace to the importing module, lazily, and merges it into the application's `ConfigService`. `ConfigService<T>` takes the loaded config shape (for example `ConfigService<ConfigShape<[typeof dbConfig]>>` in a constructor) and checks `get`/`getOrThrow` dot paths and their value types against it; `get(path, default)` returns the value type. Without `T`, reads stay `unknown`. Path expansion stops at a fixed depth, so recursive shapes stay cheap to type-check.

**Behavior change:** `registerAs(namespace, envToken, factory)` becomes `registerAs(namespace, factory)`. The factory receives the application's `ENV` (`VelaEnv`) instead of a caller-supplied token; reading the namespace throws a clear error when no runtime seeded ENV. Remove the token argument and read bindings from the factory's `env` parameter, validating each value.

**Behavior change:** `ConfigType` now means the shape of one namespace, as in NestJS: `ConfigType<typeof dbConfig>`. It replaces `InferConfigType`, which is removed with no alias. The previous tuple mapper `ConfigType<[typeof a, typeof b]>` is renamed `ConfigShape<[typeof a, typeof b]>`.
