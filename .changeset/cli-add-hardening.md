---
'@velajs/cli': minor
---

`vela add` and the generators' source edits are safer:

- `vela add queue` plans its Wrangler file edit (the producer and consumer) before `wrangler queues create`, so a Wrangler file it cannot edit, such as one whose `queues` is not an object, fails with nothing created.
- A D1, KV or R2 `BINDING` that is a JavaScript reserved word (`delete`, `class`, `await`, `eval`, ...) or a name `bindings.module.ts` declares (a class, function, variable, destructured variable or enum) or imports (`ENV`, `Global`, `InjectionToken`, `Module`, `defineProvider`, its module class) is refused before anything is created. The `export const BINDING = new InjectionToken<T>('BINDING')` an earlier `vela add` declared is reused.
- An existing `bindings.module.ts` whose module class has another name is edited and imported by that name; one that does not export its class by name fails with nothing created. A root module that imports it through a relative barrel is registered through that import.
- A module edit no longer treats a name the file declares itself, imports from another module, or imports as another export of the module (`{ Other as B }`, a default or a namespace import) as the import it needs: the edit fails naming the binding, where it used to register the wrong class. A relative module spelled with or without its extension is the same module. An entry the module already lists through a path alias or package import (`@/bindings.module`) is left as it is, since only the project's build resolves that specifier.
- Source edits keep a CRLF file CRLF, and a comment trailing the last import, export or declaration stays on its line.

**Behavior change:** with a `wrangler.toml`, which neither Wrangler nor the CLI edits, `vela add d1|kv|r2|queue` still creates and registers the resource, but prints the binding table to add (`[[d1_databases]]`, `[[kv_namespaces]]` or `[[r2_buckets]]` with the id Wrangler printed, or a queue's producer and consumer) and the type refresh under `Manual steps required`, numbered, and exits 2 instead of 0. D1, KV and R2 used to exit 0 with the binding missing from the Wrangler file. Exit codes: 0 means everything was applied, apart from the registration `--skip-import` prints; 1 that the command failed; 2 that the printed manual steps remain.
