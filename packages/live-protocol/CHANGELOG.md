# @velajs/live-protocol

## 1.24.0

### Minor Changes

- fd11d20: A live query's wire name now lives in its shared definition, so each name is declared once: `defineLiveQuery({ name: 'todos.list', args, result })`. The name must be a non-empty string of at most 256 characters, the longest a `sub` frame carries; `defineLiveQuery` throws otherwise. `LiveQueryDefinition<Name, Args, Result>` carries it as its first type parameter (all three default, so a bare `LiveQueryDefinition` accepts any definition).
  
  The server declares `@LiveQuery(definition, { tags })`, for example `@LiveQuery(todoList, { tags: [crudLiveTag('todos')] })`. The engine already validates every result with the definition's `result` schema after the resolver and its interceptors, so a resolver returns its rows as read instead of calling `.parse` itself.
  
  Clients take the same definitions as a list: `createLiveClient({ url, queries: [todoList] })` and `createNativeClient({ queries: [todoList], ... })` infer the contract, keyed by each definition's name. Two definitions with one name throw `LIVE_SCHEMA_DUPLICATE`. `new LiveClient<Contract>({ queries })` takes an explicit contract and no longer infers one from its options; `LiveQueryDefinitions<Contract>` types its list. `@velajs/react` hooks keep their API and are typed from the same list: `createLiveHooks<InferLiveContract<typeof queries>>()`, where `queries` is the array passed to `createLiveClient`.
  
  Engine errors name the definition instead of the removed decorator form: bootstrap reports "two live query definitions are named 'todos.list'" with both resolver methods, and a subscription to an unknown query receives "no live query named '…' is registered".
  
  **Behavior change:** `@LiveQuery(name, definition, options)` is removed; use `@LiveQuery(definition, options)` with `name` in `defineLiveQuery`. `defineLiveQuery({ args, result })` without a `name` no longer type-checks and throws at runtime. The client's `queries` option takes an array of definitions instead of a name-keyed map: replace `queries: { 'todos.list': todoList }` with `queries: [todoList]`. `InferLiveContract` takes the definition list type (`InferLiveContract<typeof queries>`), so React and React Native apps that typed their hooks from a `{ 'todos.list': todoList }` map export `const queries = [todoList]` instead and pass that array to both the client and `InferLiveContract`. The `LiveQuerySchemas` and `LiveQueryParsers` types are removed; use `LiveQueryDefinitions<Contract>` and `LiveQueryDefinition<Name, Args, Result>`. `LiveQueryDefinition<Args, Result>` became `LiveQueryDefinition<Name, Args, Result>`, so a two-argument annotation such as `LiveQueryDefinition<{ id: string }, Todo[]>` no longer compiles (its first argument must be a string type), and one whose `Args` is itself a string type now means a name. Name the query first: `LiveQueryDefinition<'todos.byId', { id: string }, Todo[]>`, or `LiveQueryDefinition<string, { id: string }, Todo[]>` to accept any name; or annotate with `typeof todoById`. `defineLiveQuery<Args, Result>` likewise became `defineLiveQuery<Name, Args, Result>`, with no defaults, so explicit type arguments name the query first as well (`defineLiveQuery<'todos.byId', { id: string }, Todo[]>({ name: 'todos.byId', args, result })`); or drop them and let the definition infer all three.

## 1.23.0

### Minor Changes

- 5205e58: Validate WebSocket correlation envelopes and hibernation attachments, preserve live baselines after refused sends, and add bounded connection-local send admission and incoming work. Existing void send APIs and unversioned 1.x attachments remain supported.

  Drop frames still waiting on Node connection setup after overload or close. Use browser-valid private close codes and reconnect after client-side send admission failures.

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.

## 2.0.0

Shared runtime argument/result parsers and validated live frame contracts used by the server and every client.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.1.0

### Minor Changes

- 6e9d70a: Validate live frame schemas, JSON shape, protocol versions, cursor/epoch pairs, and secure default size limits for frames, deltas, and presence metadata. Outbound encoders now reject malformed or oversized frames before serialization.

## 1.0.1

### Patch Changes

- 0fcf971: Modernize the package build, validation, and release toolchain.
