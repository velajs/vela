# @velajs/crud-memory

In-memory adapter for [`@velajs/crud`](https://github.com/velajs/vela/tree/main/packages/crud) — tests, prototypes,
and examples. Uses Web APIs without durable persistence.

```bash
pnpm add @velajs/crud @velajs/crud-memory
```

## License

MIT

Use `parseRow: (value) => schema.parse(value)` to validate stored rows and infer
the adapter's row type. Without a decoder, rows are records of unknown values.
`requestScope` is distinct from `transaction`; `memoryAdapter` remains
an explicitly non-atomic test/prototype adapter. Use `transactionalMemoryAdapter`
with an explicitly shared `MemoryStore` for serialized, rollback-capable writes
and ETag resources. It advertises `transactions` and `rowLocks`.

Direct adapter list callers now pass `options.keyset`, produced by
`resolveKeyset(cursor, fields, direction)` from `@velajs/crud/query`. Engine
requests validate this automatically. Old scalar cursors must be discarded.

`transactionalMemoryAdapter` instances sharing one `MemoryStore` can join a
`crudTransaction` scope across resources. Distinct stores or application database
registrations cannot reuse that capability. See the
[multi-database guide](../../docs/multi-database.md) for explicit routing and
transaction composition. The prototype `memoryAdapter` has no callback rollback
guarantee and is not eligible for composition.


Use `transactionalMemoryVersioningStore(store)` and
`transactionalMemoryAuditStore(store)` with that same `MemoryStore` for history
that commits and rolls back with resource rows. The stores preserve standalone
methods for seeding and administrative reads; use `withCrudTransactionStore` to
join an existing transaction. See [transactional history](../../docs/transactional-history.md).
