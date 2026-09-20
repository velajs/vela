# @velajs/cli introspection — design (vela roadmap phase 3, final item)

CLI repo: freshly `git init`-ed, baseline b44decf, branch `feat/introspection`.

## Commands (clipanion, existing loadConfig/createApp convention)

All commands: `loadConfig` → `createApp()` → read → print → best-effort
`dispose()` → exit code. `--json` flag on each for machine output; default is
aligned human tables (extend src/format.ts).

1. **`vela route:list`** — the app's HTTP routes.
   Source of truth: `app.getHonoApp().routes` (RouterRoute[]: method, path —
   includes global prefix, consumer middleware mounts, RouteContributor/CRUD
   routes, OpenAPI mounts). Enriched by joining vela controller metadata:
   for each controller (`DiscoveryService.getProviders()` filtered to classes
   with `MetadataRegistry.getControllerPath`), rows from
   `MetadataRegistry.getRoutes(cls)` → `method path controller#handler`.
   Join on method+normalized path; Hono-only rows print with handler
   `(mounted)`. Sorted by path. NOTE: getProviders() resolves instances —
   use a non-materializing walk instead: containers tokens via
   `app.getContainer().getTokens()` filtered by controller metadata presence
   (public MetadataRegistry reads only; zero instantiation, lazy-safe).

2. **`vela module:graph`** — module instances, their imports, providers,
   exports, flags. Needs ONE new vela seam (none exists):
   `Container.describeModules(): ModuleDescription[]` where
   `ModuleDescription = { moduleId, imports: string[], isGlobal: boolean,
   lazy: boolean, providers: string[], exports: string[] }` — strings only
   (token descriptions via the container's existing tokenToString),
   serializable, zero instantiation, lazy-safe. Lands in vela as its own
   small feat commit (queue-module precedent for promoting seams).
   Output: indented tree from roots (modules nobody imports), cycles guarded;
   `--json` emits the raw array.

3. **`vela entrypoint:list`** — `app.entrypoints.kinds()` + `all()` grouped
   by kind: `kind token#method meta`. 1.13 metadata-only entries print
   without materializing lazy modules (instance presence irrelevant — tokens
   + meta only). Kinds with zero entries listed from `kinds()`.

4. **`vela openapi:dump`** — `createOpenApiDocument(rootModule, options)`
   requires the ROOT MODULE, which `createApp()` does not expose →
   `VelaConfig` gains OPTIONAL `rootModule?: Type` (backward-compatible;
   command errors with a config example when absent). `--out <file>` writes;
   default stdout. `--title/--version` pass through to options if supported
   (check CreateOpenApiDocumentOptions; do not invent).

## Vela seam details (Container.describeModules)

Reads `this.scopes` (moduleId, importedModules, exportedTokens, isGlobal,
lazy) + `this.providers` buckets (token keys in registration order).
Root bucket (`__root__`) included last with imports []. No instances touched;
callable pre- or post-bootstrap. ~35 lines + unit test in vela.

## Testing (cli repo)

Fixture app in `src/__tests__/fixtures/` (small vela app: 2 controllers w/
prefix+version, an imported+exported provider module, one lazy module, the
queue module for a non-HTTP kind, openapi-decorated route). Tests drive the
COMMAND FUNCTIONS (extract core logic per command into a testable function
taking the app + returning rows/objects; clipanion classes stay thin shells)
— no subprocess spawning. Format tests extend the existing format.test.ts
pattern. `pnpm typecheck` + `pnpm test`; cli consumes @velajs/vela via its
node_modules (check symlink → working-tree vela so the new seam resolves;
document relink like storage).

## Non-goals

Watch mode, graph images (dot/mermaid output can come later — `--json` is
the composable primitive), publishing @velajs/cli to npm / creating the
GitHub repo (user's call — flagged in the final report).

## v2 amendments (panel reconciliation)

- Controller detection + path joining are NOT publicly derivable (evidence:
  @Controller writes no discoverable meta; metadata paths are handler-relative
  vs Hono's globalPrefix+version+prefix composition; no prefix accessor).
  RESOLUTION — vela exposes its own truth (1.15 seams, one feat commit):
  `VelaApplication.describeRoutes(): RouteDescription[]` (RouteManager records
  every explicit route AS REGISTERED: method incl. HEAD as declared, fully
  composed path, controller name, handler, version), `app.getGlobalPrefix()`,
  `Container.getModuleDescriptions()` (renamed from describeModules;
  ModuleDescription exported; scope.lazy normalized to boolean; root bucket
  via ROOT_MODULE_ID with imports []), and export the existing `describeToken`.
- route:list = describeRoutes rows + hono `.routes` diff (drop method 'ALL';
  rows not present in describeRoutes → '(mounted)': CRUD/contributed/manual
  mounts). Guard getHonoApp() throw → "no HTTP routes" exit 0.
- entrypoint:list kind universe from exported `getEntrypointKinds()`;
  entries left-joined via ofKind (metadata-only lazy entries fine).
- openapi:dump: `--title/--version` → `options.info.{title,version}`;
  globalPrefix from `app.getGlobalPrefix()` (flag `--global-prefix` overrides).
- Command paths (clipanion, seed convention): [['route','list']],
  [['module','graph']], [['entrypoint','list']], [['openapi','dump']].
- Build/link chain for cli tests: build vela in the queue-module worktree →
  temporarily relink cli/node_modules/@velajs/vela → worktree → test →
  restore ../../../vela. Peer/devDep bump to >=1.15.0 with the seam release.
