---
'@velajs/cli': minor
---

The CLI reads the Durable Object classes a Worker entry defines through `@velajs/cloudflare`. It finds the root module of an entry that uses `defineCloudflareApp(AppModule)` as well as one that uses `createCloudflareWorker(AppModule)`.

**Behavior change:** `vela g durable-object counter` writes an `@Injectable()` host (`counter.host.ts`, which injects `DO_STORAGE`) and a `VelaDurableObject` class instead of a hand-written `DurableObject` subclass. The class lists the host's `increment` method in `rpc`, typed on its binding once `vela cf sync --write` binds it and `wrangler types` runs; list further host methods there to expose them. Where the class goes follows the Worker entry, so it shares the app's runtime adapters:

- An entry that binds its app (`const app = defineCloudflareApp(AppModule, options)`) gets `export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment'] }) {}` declared after the app. A separate file importing the entry would run before the entry defined the app.
- An entry that imports its app from its own module (`import { app } from './app.js'; export default app.worker;`) gets `counter.durable-object.ts`, which imports that app, exported from the entry.
- Otherwise `counter.durable-object.ts` builds the class from the root module the entry names (`VelaDurableObject(AppModule, CounterHost, { rpc: ['increment'] })`), exported from the entry as before. When the entry passes options, such as runtime adapters, to `createCloudflareWorker()` or an unnamed `defineCloudflareApp()`, the generator notes that the class does not share them and how to define the app once. An entry that names no root module fails with guidance.
- `--skip-import` prints the declaration or export to add instead.

**Behavior change:** `vela cf sync` binds a gateway binding that no class serves to the one exported `VelaWebSocketDurableObject` class without a binding, and never to a `VelaDurableObject` host class. It also warns about a Durable Object class the app defines that the Worker entry does not export, naming the call that defined it with its `rpc` list, so you export that class.

**Behavior change:** without a config, `vela entrypoint list` adds `cf:durable-object` rows: the Durable Object classes built by `@velajs/cloudflare` that the Worker entry exports, by export name, with what they serve and their RPC methods, and the classes the app defines without exporting them. `vela deploy check` reads those rows. It warns with `unbound-durable-object` about an exported class that no `durable_objects` binding of the selected environment names, and with `unexported-durable-object` about a class the entry does not export. It warns with `rpc-error-serialization` when an exported host class has RPC methods and the selected environment's `compatibility_date` predates 2026-04-21 without the `enhanced_error_serialization` flag (or sets `legacy_error_serialization`): workerd then delivers a failed call's `EntrypointError` without its status, code and details.
