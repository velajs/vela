# Required decorator data and explicit lazy parameters

Implemented in the core HTTP decorators; no installs, builds, manifests, lockfiles or commits were performed by this lane.

## Contract

`createParamDecorator((data: string, ctx) => ...)` now requires data: `Header('x-id')` compiles, while `Header()` and `Header(undefined)` fail. Factories accepting `undefined` continue to support a zero-argument decorator. A conditional tuple controls the public call signature, and the implementation forwards the captured value without asserting it into `TData`. Ordinary parameter pipes remain supported.

`createLazyParamDecorator` injects an explicit `() => Result` function. Calling it executes the factory once; later calls return the same value or Promise, or rethrow the same synchronous thrown value. Primitives, null, undefined, objects and promises preserve their real behavior. There is no proxy, thenable trap, fabricated generic result or assertion in the lazy implementation. Lazy-specific pipe arguments were removed because parameter pipes would transform the injected function rather than its eventual result. Validate produced values in the factory.

Both eager and lazy decorators observe guards-first extraction. Lazy resolution is an optimization for work a handler might not need, not a way to repair pipeline ordering.

## Files and consumers

- `vela/src/http/decorators.ts`: conditional required-data signature; removed data/context assertions from the custom factory invocation.
- `vela/src/http/lazy-param.decorator.ts`: small memoized thunk implementation built on the ordinary decorator registration path.
- `vela/src/__tests__/lazy-param-decorator.test.ts`: rewritten around real thunk semantics and typed request-context access.
- `vela/src/__tests__/custom-param-decorator.typecheck.ts`: compiler negatives for omitted/wrong/undefined required data and removed lazy pipe arguments; positive optional and async cases.
- `testing/src/__tests__/testing-module.test.ts`: migrated its one active lazy consumer to call the injected loader and corrected guard-order comments.
- `vela/README.md`, public API comments and major changeset updated. Bundled skill guidance was sent to the coordinating task, whose documentation lane owns those files.
- Read-only audit found no other active API-workspace lazy consumers. Existing ordinary auth, authz, CRUD and Cloudflare decorator factories accept optional/unknown data or already supply required data.

## Verification

- Core `tsc --noEmit` passed, including the negative compiler fixture.
- All 340 tests passed across lazy parameters, deep features, NestJS parity, parameter decorators, execution-context module isolation and programmatic routes. Eighteen focused cases cover guards before extraction, denied requests skipping factories, unused lazy values, actual primitive/undefined/null/object behavior, cached promises, cached synchronous thrown values including undefined, rejected promises, HTTP error propagation, typed request-context state and constructor misuse.
- Lint returned no source errors or warnings; test-only style warnings remain.
- The testing package regression is migrated and awaits the coordinating task's rebuilt core artifact before its final runtime run.

## Remaining reflection boundary

Legacy TypeScript parameter decorators cannot inspect the declared TypeScript type of the parameter they decorate. Handler annotations must therefore describe the documented injected value (`() => User` for a lazy factory), just as ordinary parameter decorator annotations must describe their result. No generic assertion claims to establish that relationship. The existing class-constructor reflection assertions used to register parameter metadata remain; this change does not broaden metadata reflection scope.
