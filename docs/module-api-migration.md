# Module API migration

Update Vela and affected integrations together. These changes are minor releases
on the 1.x line and remove replaced APIs without compatibility aliases.

## Registration signatures

| Ownership | Public methods | Modules |
| --- | --- | --- |
| Shared application facility | `forRoot(options)`, `forRootAsync(options)` | Config, Errors, Cache, Logging, Security, Throttler, I18n, Schedule, Queue, WebSocket, Live, OpenApi, BetterAuth, Authz, Cedar, CloudflareAccess, Tenant, FeatureFlags, Crud, Graphql, Rpc, Studio |
| Independent local service | `register(options)`, `registerAsync(options)` | Http, Mail, Crypto |
| Named resource | `register(options)`, `registerAsync(options)` | Storage, RpcClient |
| Ordinary module | `imports: [ModuleClass]` | EventEmitter, Health, ScheduleNode |
| Shared registry with feature declarations | `imports: [SeederModule]`, `SeederModule.forFeature(seeders)` | Seeder |

Config and CRUD retain their existing `forFeature` methods. Replacements:

```ts
QueueModule.forRoot({ driver });
QueueModule.forFeature([{ name: 'email', binding: 'EMAIL_QUEUE' }]);
I18nModule.forFeature({ en: { greeting: 'Hello' } });
SeederModule.forFeature([ExampleSeeder]);
HttpModule.register({ baseURL: 'https://catalog.example.com' });
```

Queue and Seeder take readonly arrays, including empty arrays. Replace
`registerQueue(a, b)` with `forFeature([a, b])`, `registerMessages(messages)` with
`forFeature(messages)`, and `SeederModule.forRoot({ seeders })` with
`SeederModule.forFeature(seeders)`. Queue's naming is Vela's convention;
[Nest uses `registerQueue`](https://docs.nestjs.com/techniques/queues).

Http, Mail and Crypto create an independent local instance per registration call.
Reuse a returned dynamic definition to share that instance within an application.
Each application still constructs separate providers. Explicit `key` values
preserve deduplication and reject conflicting configurations. Storage and RPC
clients retain resource-name uniqueness. Mail retains one processor owner per
queue and one application-wide inbound gate.

For module authors, `defineModule({ identity: 'structural' })` remains the default;
`ConfigurableModuleBuilder` defaults to `identity: 'registration'`. The latter
assigns an opaque key per call. Changing the generated method name does not change
identity. An explicit key or a spec's custom key function takes precedence.

## Attach configured components explicitly

Importing BetterAuth, Authz, Cedar, Tenant, CloudflareAccess, FeatureFlags, Cache or
Throttler provides and exports components. Install the ones the application needs:

```ts
@Module({
  imports: [auth, tenant, authorization, cache],
  providers: [
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_GUARD, useExisting: TenantGuard },
    { provide: APP_GUARD, useExisting: PermissionGuard },
    { provide: APP_INTERCEPTOR, useExisting: CacheInterceptor },
  ],
})
class AppModule {}
```

Use `RolesGuard`, `CedarGuard`, `CloudflareAccessGuard`, `FeatureFlagGuard` and
`ThrottlerGuard` the same way when needed. Route-level `@UseGuards` and
`@UseInterceptors` remain available. Remove `guard` installation options.
`isGlobal` controls exported provider visibility only. Keep authentication,
tenant admission and authorization consistently global or consistently route-level
so global authorization cannot run before route authentication.

Tenant and Cedar aliases keep their module-owned configuration, including
request-scoped resolution; ambiguous owners still fail. Authz selects policy from
the route's owner. Guard phases, `Public`, declared integration-route exemptions,
and Security/i18n middleware behavior remain intact.

## Return runtime configuration from async factories

Only values that create tokens, imports, providers or routes remain structural:

| Module | Declaration-time values | Factory result |
| --- | --- | --- |
| Storage | `name`, `httpController` | `driver`, `http` settings and other runtime options |
| WebSocket | No driver or registry declarations | `sync`, registry and other runtime options |
| Live | `presence?: boolean` (default `true`) | `presenceOptions` and other runtime options |
| Mail | `queue` | `inbound.gate` and mailer options |
| Cedar | No `undeclared` declaration | `undeclared` (default `deny`) and engine options |
| Errors | `handler` | `catalogs` and runtime options |
| Schedule | No dispatch declaration | `dispatch` policy |

```ts
StorageModule.registerAsync({
  name: 'uploads',
  httpController: { path: '/files' },
  inject: [StorageConfig],
  useFactory: (config) => ({
    driver: config.createDriver(),
    http: {
      authorize: config.authorize,
      maxUploadSize: config.maxUploadSize,
      multipartGrantSecret: config.secret,
    },
  }),
});
```

Absent or false `httpController` mounts no routes. Remove `http.mountController`,
`http.basePath` and top-level `multipartGrantSecret`; put the secret under `http`.
Live keeps its 30-second presence TTL unless `presenceOptions.ttlMs` overrides it.
WebSocket defaults allocate state per application; use driver/registry factories
when reusing declarations across applications. Reusing supplied mutable instances
across application owners fails.

Config namespaces, Studio plugins, Better Auth mounting, GraphQL path/imports,
RPC client name/binding and feature provider declarations remain structural.

## Application-owned translations

Only imported `I18nModule.forFeature` definitions contribute messages. Repeated
imports deduplicate; later contributions in module registration order override
earlier leaves. Applications cannot see each other's feature catalogs. Lazy
loading, ICU formatting, locale detection and fallback behavior remain available.
See [i18n](i18n.md).

## GraphQL and portable workflows

GraphQL accepts either an executable `schema` or `typeDefs` with `@Resolver`,
`@Query`, `@Mutation`, `@ResolveField`, `@Args`, `@Parent`, `@Context` and `@Info`.
In SDL mode, `include` selects providers declared by specified module classes;
omitting it scans the application graph, and `[]` selects none. Selection never
imports a module. Duplicate type/field bindings fail. SDL performs input coercion;
optional method `args` and `output` schemas use the existing validation pipeline.
See [GraphQL](../packages/graphql/README.md).

`VelaWorkflow(app, HostClass)` remains available. Import `VelaWorkflowDefinition`
from `@velajs/cloudflare/workflow-definitions` to host a `defineWorkflow` or
`compileAgent` definition. Declare a payload schema, tuple-inferred `inject` and
`useFactory` returning `{ definition, run }`. Input validation runs before factory
dependencies resolve. Each native run gets a fresh context; dispatch wiring,
authentication and tenant authority remain explicit application responsibilities.
See [Cloudflare workflows](../packages/cloudflare/README.md).
