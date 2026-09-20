# Feature flags: validated object results and checked providers

Status: source implementation complete; coordinating task owns cross-package builds and integration. Cloudflare owns KV/Flagship adapter changes, and Studio owns its object-evaluation consumer. No manifest/lockfile edits or dependency installation by this lane.

## Contract

`FeatureFlagDriver.getObject(key: string, fallback: object, ctx?: FlagContext): Promise<unknown>` replaces the caller-selected generic. An arbitrary object payload cannot prove an application's domain type.

The service validates that boundary:

```ts
getObjectValue<T extends object>(
  key: FlagKey,
  parse: (value: unknown) => T,
  fallback: NoInfer<T>,
  context?: FlagContext,
): Promise<T>
```

`getObjectDetails` accepts the same parameters and returns `FlagEvaluationDetails<T>`. The parser determines `T`; the fallback cannot widen it. Driver, context, and parser failures retain the typed fallback and never throw from evaluation. Parser failures appear as `ERROR` in details. There is no backwards-compatible parser-less overload or invented empty-object default.

Primitive evaluation retains manifest defaults, now only if the default has the requested primitive type. Batch `all()` retains object flags as broad `object` values and falls back when a driver returns a primitive for an object flag; it makes no domain-schema claim. Arrays remain supported through an appropriate parser.

## Changes

- Raw driver object contract no longer promises a caller-selected `T`.
- Memory driver checks actual boolean/string/finite-number/object values instead of asserting a generic map lookup.
- Service object evaluation parses unknown payloads, with a required valid fallback.
- Primitive manifest selection uses real type guards instead of casting a flag's arbitrary declared value to the requested type.
- Batch evaluation uses entry pairs instead of asserting matching positions across separate key/value arrays.
- Module provider factories, class bindings, and guard aliases now use core `defineProvider`; callback dependencies are inferred from injection tokens. Removed the module extras assertion.
- Core `live.module.ts` resource factories and the related live/feature-flags test registrations were also migrated to checked provider definitions.
- README documents the new driver/service contract and parser usage.

## Verification

- Baseline: source typecheck passed and 32 tests passed.
- Updated package: `tsc --noEmit` passed and all 39 tests in six files passed, including a final rerun after checked-provider migration.
- Compile-only fixture `src/__tests__/object-api.typecheck.ts` passed with TypeScript's command-line `--ignoreConfig` plus strict/decorator/module flags. It rejects: a generic raw driver return, parser-less typed object retrieval, an incompatible fallback, and a caller-chosen type contradicting the parser. Correct calls infer the parser's result for values and details.
- Changed source lint has no errors; an ordinary test helper placement warning remains.
- Core live regression suite passed 40 tests before the in-progress descriptor-only container migration. During that coordinated migration, its rerun stopped at `CheckedProvider.read` because other core module helpers still emitted raw provider objects. Owned live/feature-flags registrations are migrated; core owner must finish the central migration before integration rerun.

## Cross-package handoff

- Cloudflare task `01a0bd3b-6bd9-7c80-9fde-6008e96c8322` received the exact raw-unknown driver contract and owns `KvFlagDriver`, `FlagshipFlagDriver`, and the Flagship binding interface. Root confirmed those drivers have been updated and rebuilt feature-flags declarations.
- Studio's `packages/server/src/flags/index.ts` must pass a parser to `getObjectDetails(key, parser, declaredDefault, context)`. Generic Studio inspection can validate non-null object shape; it should not invent a more specific domain type.
- This is a deliberate breaking API change. Release metadata is owned by the coordinating task.

Unrelated reflection casts in the feature-flag guard and legacy test request mocks were not expanded into this bounded task.
