---
'@velajs/cli': minor
---

The CLI reads the Durable Object classes a Worker entry defines through `@velajs/cloudflare`. It finds the root module of an entry that uses `defineCloudflareApp(AppModule)` as well as one that uses `createCloudflareWorker(AppModule)`.

**Behavior change:** `vela g durable-object counter` writes an `@Injectable()` host (`counter.host.ts`, which injects `DO_STORAGE`) and `export class Counter extends VelaDurableObject(AppModule, CounterHost) {}` (`counter.durable-object.ts`), built from the root module the Worker entry names, instead of a hand-written `DurableObject` subclass. The Worker entry exports the class as before. The host's public methods are the class's RPC methods, typed on its binding once `vela cf sync --write` binds it and `wrangler types` runs. An entry that names no root module fails with guidance.

**Behavior change:** `vela cf sync` binds a gateway binding that no class serves to the one exported `VelaWebSocketDurableObject` class without a binding, and never to a `VelaDurableObject` host class. It also warns about a Durable Object class the app defines that the Worker entry does not export.

**Behavior change:** without a config, `vela entrypoint list` adds `cf:durable-object` rows: the Durable Object classes built by `@velajs/cloudflare` that the Worker entry exports, by export name, with what they serve and their RPC methods, and the classes the app defines without exporting them. `vela deploy check` reads those rows. It warns with `unbound-durable-object` about an exported class that no `durable_objects` binding of the selected environment names, and with `unexported-durable-object` about a class the entry does not export.
