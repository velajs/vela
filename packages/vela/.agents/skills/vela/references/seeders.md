# Seeders (`@velajs/vela/seeder`)

Ordered, DI-aware data seeders on the **subpath** `@velajs/vela/seeder`. The module is lazy. Seeders are run by the `@velajs/cli` command `vela db seed`, or programmatically via `runSeeders(app)`.

## Writing a seeder

`@Seeder({ name?, order? })` marks a class (and auto-marks it `@Injectable()`). Implement the `Seeder` contract — the method is **`run()`**:

```ts
import { Seeder, SeederModule, runSeeders } from '@velajs/vela/seeder';

@Seeder({ order: 1 })
class UserSeeder {
  constructor(@Inject(DB) private readonly db: Db) {}   // full DI available
  async run() {
    await this.db.insert('users', [{ name: 'Alice' }]);
  }
}

@Seeder({ order: 2 })
class ProductSeeder {
  async run() { /* ... */ }
}
```

`SeederMetadata`: `name?` (defaults to the class name) and `order?` (ascending, default `0`). Seeders run in `order`.

## Registering

Register seeder classes via `SeederModule.forFeature(seeders)` (or list them in any module's `providers`):

```ts
@Module({
  imports: [SeederModule.forFeature([UserSeeder, ProductSeeder])],
})
class AppModule {}
```

## Running

The CLI resolves the registry against a built app and runs each seeder's `run()` in `order`:

```bash
vela db seed              # from @velajs/cli — build app, run all @Seeder classes
vela db seed --list --json # inventory with module owners; does not call run()
```

Programmatically:

```ts
const app = await VelaFactory.create(AppModule);
const results = await runSeeders(app);   // [{ name, ok, error? }, ...]
```

`SeederRegistry` exposes `list()` (registered seeders in run order, including optional `moduleId`) and `runAll({ stopOnError? })`; `stopOnError` defaults `true`. Discovery retains each module registration and does not construct lazy providers. The same seeder token in two feature modules executes once per owner against its own dependencies. Inventory/bootstrap replay does not append duplicate entries.

Each invocation resolves the owned provider asynchronously in a fresh managed request scope, calls `run()`, settles registered deferred work and disposes request resources before the next seeder. `EXECUTION_LIFETIME` is injectable; no HTTP request/tenant/identity is invented. Handler and completion failures are preserved, and `stopOnError: false` continues after settlement. Container disposal retains its normal error policy. Results remain `{name, ok, error?}` for 1.x compatibility. There is no "run one" method; use `runAll`.

Use explicit database tokens for multi-database seeding. The runner adds no transactions, retries or cross-database atomicity. The CLI's `--list` still bootstraps/disposes the app, so normal lifecycle hooks run; it does not invoke seeders.
