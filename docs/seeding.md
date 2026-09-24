# Database seeding

Seeders are application providers. Import `SeederModule` and register
`@Seeder()` classes in their owning feature modules. In a Workers project
`vela db seed` needs no configuration: the CLI loads the Worker entry Wrangler's
`main` names through Vite, so no build runs first, and builds the application
with the local bindings Wrangler's `getPlatformProxy()` provides, persisted in
`.wrangler/state` like `vite dev` (`--env` selects a named environment). Point a
`vela.config.ts` at the application source to build it another way; the CLI
loads the config and the decorated files it imports the same way:

```ts
// vela.config.ts
import { defineVelaConfig } from '@velajs/cli/config';
import { VelaFactory } from '@velajs/vela';
import { AppModule } from './src/app.module.js';

export default defineVelaConfig({ createApp: () => VelaFactory.create(AppModule) });
```

Without Vite in the project, use a `vela.config.mjs` that imports the compiled
app instead. See the [CLI configuration guide](../packages/cli/README.md#configure).

```ts
import { Inject, Module } from '@velajs/vela';
import { Seeder, SeederModule } from '@velajs/vela/seeder';
import { DatabaseModule, DATABASE, type Database } from './database.js';

@Seeder({ name: 'users', order: 10 })
class UsersSeeder {
  readonly #database: Database;

  constructor(@Inject(DATABASE) database: Database) {
    this.#database = database;
  }

  async run() {
    await this.#database.insertUser({ id: 'example-user', name: 'Ada' });
  }
}

@Module({ imports: [SeederModule, DatabaseModule], providers: [UsersSeeder] })
export class AppModule {}
```

`DatabaseModule`, `DATABASE` and `Database` above represent the application's own
database provider. Seeders use the registration's module owner when resolving
dependencies. Registering one seeder class in two keyed feature modules runs both
registrations against their own providers; there is no global current database.
Use explicit named database tokens in multi-database applications. The runner
does not create transactions or promise atomicity across database connections.

```sh
vela db seed --list --json
vela db seed
vela db seed --continue-on-error
```

`--list` bootstraps the configured app and prints name, order, class-token label
and module owner. It does not call `run()` or construct lazy seeders for inspection.
Normal application startup/shutdown hooks still run. JSON reports `moduleId: null`
when an older Vela version cannot provide ownership. `--json` requires `--list`;
`--continue-on-error` is only for execution.

Seeders execute sequentially by ascending `order`; equal orders retain token
registration order, then owner registration order. Async factories are awaited in the owning module. Every
invocation gets a fresh managed request scope and can inject `EXECUTION_LIFETIME`
to register deferred work. The runner waits for the handler and its managed work,
then releases constructed request-scoped resources before starting the next
seeder. Singletons retain normal application lifetime. No HTTP request context,
tenant or authorization identity is fabricated.

The default stops after the first failed invocation, including deferred completion
failures. `--continue-on-error` settles each invocation and continues. Handler and
completion failures are retained together when both fail. Existing container
disposal policy still governs disposable-hook errors. The result shape from
`runSeeders(app)` remains `{ name, ok, error? }`; `app.get(SeederRegistry).list()`
adds the optional `moduleId` field for owner-aware inventories. Repeated inventory
reads and bootstrap replay do not accumulate duplicate entries.

The CLI always attempts application disposal after execution or inventory errors.
A teardown warning does not replace the command's result. Seeders are explicit
operator actions: make application-level retries/idempotency and data policy
intentional; the runner adds no retries or database-specific migration behavior.
