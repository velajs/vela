# CRUD implementation report

Date: 2026-09-20. Workspace: `/Users/kauan/Projects/velajs/crud`.

## Outcome

Cursor validation now belongs to the engine boundary. Versioned tokens carry the configured cursor column followed by every primary-key column, with scalar/date types, Unicode, direction, and ordering fields retained. Malformed, legacy scalar, wrong-order, wrong-arity, and wrong-schema-type tokens fail before adapter access. Both memory and Drizzle use the complete tuple, including explicit null ordering. Deleting the previous boundary row does not restart or skip the walk. Read-policy enumeration applies the same tuple pagination after authorization; hidden and foreign-tenant rows do not inflate totals. Existing ascending cursor ordering and offset sorting are retained.

The adapter contract now separates `requestScope` from callback `transaction`. Ordinary read/list/search/aggregate/export and version-history ownership checks use request scopes. SQL adapters still open real transactions when `onOpenTransaction` supplies transaction-local tenant/RLS state. D1 uses an explicit `driver: 'd1'` discriminant, advertises no callback transactions/nested writes/cascades, and supports real scoped basic CRUD through ordinary reads and atomic `RETURNING` mutations. Unsupported rollback-dependent operations fail with `TRANSACTION_UNSUPPORTED` before writes; the adapter never runs the callback in a fake transaction.

Public resource/controller configuration now binds hooks to the model's Zod shape, then compiles a validated dynamic runtime representation. The old resource double assertion is removed. Persisted rows are checked before typed hooks/policies see them. Partial write and shaped-read parsers preserve omitted fields, including omitted defaults, and keep extra relation/computed fields as unknown. Hook inputs, explicit replacements, and in-place mutations are validated. Sequential, parallel, and fire-and-forget behavior is retained, including synchronous mutation timing; arbitrary read/list transform outputs remain supported. Before-update replacements and after-list replacements now reach the executor result as promised by their public contracts.

Typed adapter facades infer their row type from an actual `parseRow` function instead of accepting a generic that invents database output. An explicit `runtime` view lets schema-bound resources consume those facades without erasing their typed write methods. Custom adapters are bound with `bindAdapter`. Relation inspections retain child records rather than incorrectly claiming the parent's row type.

CRUD integration uses checked `defineProvider` descriptors, inferred token resolution, `defineDto` descriptors, and concrete ExecutionContext accessors. Optional store tokens include `undefined`. Hook metadata is compiled before storage; no assertion is needed to erase heterogeneous author callbacks. Heterogeneous headless registration uses `defineCrudFeature` per entry. The harbor example and HTTP fixtures are migrated.

## Verification

All three original package typechecks passed at baseline before edits. Current verification uses the coordinator's linked workspace and local declarations:

| Check | Result |
| --- | --- |
| Core full runtime suite | 631 tests passed in 34 files |
| Memory adapter suite | 21 tests passed |
| Drizzle SQLite + PGlite/Postgres suite | 28 tests passed |
| Root CRUD conformance | 103 tests passed in 16 files |
| Core full source/test typecheck | Passed |
| Memory source/test and facade type regressions | Passed |
| Drizzle source and facade type regressions | Passed |
| New D1/cursor integration tests checked against generated declarations | Passed with strict temporary paths config |
| Three package builds | Passed |
| Changed TypeScript formatting and `git diff --check` | Passed |
| Changed-file lint | No errors; existing-style warnings remain |

The 103 conformance tests include 8 new memory/libsql cursor boundary cases and 3 actual workerd D1 cases through Miniflare 5. D1 tests execute binding-backed SQLite CRUD and verify tenant isolation, soft deletes, tied cursor values, totals, and refusal to invoke unsupported callback transactions. Unsupported hooks, write policies, and batch writes are rejected without modifying stored rows. The tests need no Cloudflare account or credentials.

Type regressions assert public-factory inference (resource, decorator, headless feature), persisted-versus-partial callback values, invalid callback replacements, typed adapter write rejection, and D1 configuration restrictions. Runtime regression coverage checks invalid persisted records before policy execution, sparse shaped transforms, arbitrary outputs, mutation preservation across hook modes, and existing nested authorization/include behavior.

Full persisted-row validation exposed inaccurate fixtures: clone reset removed a required `qty`, and the conformance model declared `deletedAt` as string although both adapters store epoch milliseconds. The clone test now makes only its resettable local field optional; conformance declares the actual numeric timestamp. Existing behavior and authorization assertions were preserved.

## API migration

- Custom adapters must implement `requestScope(fn, context)` separately from `transaction(fn, context)` and expose their runtime operations with `bindAdapter(...)`. To override a bound adapter, use `bindAdapter({ ...base.runtime, overrides })`; spreading the facade alone retains its original runtime reference.
- Adapter list calls receive validated `options.keyset`; raw `options.cursor` is rejected. Existing scalar cursor tokens must be discarded and pagination restarted. Direct callers can use `resolveKeyset`.
- Supply `parseRow: value => schema.parse(value)` for typed direct adapter access. Without it, results remain records with unknown values.
- `ResourceConfig<Shape>` and `CrudConfig<Shape>` use `typeof schema.shape`; inline factories infer it from the model. Use `satisfies` for extracted configuration. `CrudResource` no longer accepts a caller-selected row generic.
- Wrap every headless entry in `defineCrudFeature({ path, model, ... })` before `CrudModule.forFeature([...])`. Hooks are compiled while their schema is still known.
- Hook writes/transforms are partial, persisted hooks are full rows, and `afterList` receives `Page<unknown>` because transforms may return arbitrary values. Database/model mismatches are rejected. Schema defaults do not persist database values.
- D1 configuration uses `driver: 'd1'`; it forbids non-SQLite dialects and `onOpenTransaction`. Basic atomic CRUD is supported. Rollback-dependent hooks, nested writes, synthesized batch/upsert/restore/clone, and row-dependent update/delete guarantees require callback transactions and fail explicitly.
- All four owned factory providers already specify actual `inject` tuples. CRUD has no separate async-options generic: `forRootAsync` is inherited from core `defineModule` and adopts its mandatory-inject rule.

The new changeset marks all three packages major because these are intentional API breaks. Root owns final release version coordination.

## Boundaries and remaining limitations

The one intentional new reflection assertion is `asDatabase` in `packages/drizzle/src/database.ts`. It checks that the trusted Drizzle handle has required methods, then explicitly erases incompatible dialect-specific fluent-builder overloads. It is not disguised as a type guard proving those signatures. Public handles use actual upstream method types; rows remain records and are decoded before claiming a schema. No `any`, double assertion, or resource/hook erasure assertion was introduced in the rewritten boundary. Older model-registry, policy, store, and unrelated extended-engine assertions are outside this lane.

MySQL code paths remain untested against a real server. PGlite validates PostgreSQL syntax/behavior locally; it is not a remote managed Postgres/RLS deployment. Transaction-context read propagation is regression-tested, but no external RLS deployment was exercised. D1's atomic SQL batch facility cannot suspend for JavaScript callbacks and is not presented as such. Ordinary read scopes do not promise a multi-statement snapshot. The memory adapter retains its explicitly documented non-atomic prototype transaction sentinel and does not claim the `transactions` capability. Following a successful create, external audit capture remains a separate post-write action, as before.

Existing cross-application compiled-controller cache semantics were left unchanged. Package publication checks and final all-workspace integration belong to the coordinator. The final core declaration refresh (invariant typed tokens, nongeneric runtime token identities, mandatory factory inject tuples, DTO/config/status changes) was checked on 2026-09-20: all three CRUD typechecks and builds pass, with all 783 tests passing again. No additional integration fix was needed.

## Ownership

Owned changes are in CRUD core adapter/query/kernel/integration source and related tests, memory and Drizzle adapters/type regressions, D1/cursor conformance fixtures, package READMEs, PARITY/ROADMAP notes, the harbor example, and `.changeset/compound-cursors-d1-scopes.md`. The pre-existing bare-filter fix and its changeset were preserved. Coordinator changes to manifests, lockfiles, workspace configuration, dependency versions, and build configuration were not overwritten or claimed as lane work.

The coordinator explicitly authorized two bounded subagents for schema-hook compilation and CRUD/core API integration. No commits, publication, or deployment were performed. `MODERNIZATION.md` was not edited.
