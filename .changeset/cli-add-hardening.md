---
'@velajs/cli': minor
---

`vela add` and the generators' source edits are safer:

- `vela add queue` plans its Wrangler file edit (the producer and consumer) before `wrangler queues create`, so a Wrangler file it cannot edit, such as one whose `queues` is not an object, fails with nothing created.
- A D1, KV or R2 `BINDING` that is a JavaScript reserved word (`delete`, `class`, `await`, `eval`, ...) or a name `bindings.module.ts` declares or imports (`ENV`, `Global`, `InjectionToken`, `Module`, `defineProvider`, its module class) is refused before anything is created.
- An existing `bindings.module.ts` whose module class has another name is edited and imported by that name; one that does not export its class by name fails with nothing created.
- A module edit no longer treats a name the file imports from another module, or declares itself, as the import it needs: the edit fails naming both modules, where it used to register the wrong class. A relative module spelled with or without its extension is the same module.
- Source edits keep a CRLF file CRLF, and a comment trailing the last import, export or declaration stays on its line.

**Behavior change:** with a `wrangler.toml`, which the CLI does not edit, `vela add queue` still creates and registers the queue but prints its producer and consumer under `Manual steps required`, numbered, and exits 2 instead of 0. Exit codes: 0 means everything was applied, 1 that the command failed, 2 that the printed manual steps remain.
