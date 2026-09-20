# @velajs/crud-memory

In-memory adapter for [`@velajs/crud`](https://github.com/velajs/crud) — tests, prototypes,
and examples. No persistence, no transactions (no-op scope), edge-safe.

```bash
pnpm add @velajs/crud @velajs/crud-memory
```

## License

MIT

Use `parseRow: (value) => schema.parse(value)` to validate stored rows and infer
the adapter's row type. Without a decoder, rows are records of unknown values.
`requestScope` is distinct from `transaction`; the memory transaction remains
an explicitly non-atomic test/prototype scope.

Direct adapter list callers now pass `options.keyset`, produced by
`resolveKeyset(cursor, fields, direction)` from `@velajs/crud/query`. Engine
requests validate this automatically. Old scalar cursors must be discarded.
