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

Register seeder classes via `SeederModule.forRoot({ seeders })` (or list them in any module's `providers`):

```ts
@Module({
  imports: [SeederModule.forRoot({ seeders: [UserSeeder, ProductSeeder] })],
})
class AppModule {}
```

## Running

The CLI resolves the registry against a built app and runs each seeder's `run()` in `order`:

```bash
vela db seed              # from @velajs/cli — build app, run all @Seeder classes
```

Programmatically:

```ts
const app = await VelaFactory.create(AppModule);
const results = await runSeeders(app);   // [{ name, ok, error? }, ...]
```

`SeederRegistry` (injectable) exposes `list()` (registered seeders in run order) and `runAll({ stopOnError? })` — `stopOnError` defaults `true` (abort on first failure). Each seeder runs in its own request-scoped child container (resolved, `run()` called, disposed). There is no "run one" method — use `runAll`.
