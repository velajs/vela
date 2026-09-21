# Inventory from domain history

Run from the monorepo root with Node 24+ and pnpm 11.11.0:

```sh
pnpm install
pnpm --filter @velajs/event-source build
pnpm --filter event-sourcing-inventory start
```

Expected output: `{"available":12,"totalReceived":15,"replayedTail":1}`.
The example also runs under the root test gate and against the packed package
outside the workspace in release consumer checks.

The log records receiving 10 items, reserving 3, then receiving 5. It restores the
available-stock projection from an atomic checkpoint and folds only the last
event. A new total-received projection rebuilds from history: that answer cannot
be recovered from the current balance of 12 alone. Duplicate delivery does not
increment either existing projection's watermark twice.

This example is intentionally local and has no server or database dependency.
The log and snapshot store are in memory. A production application must persist
the domain history, scope it to its tenant/environment, serialize access to each
projection, and atomically commit its domain writes or use a transactional
outbox. A checkpoint is a rebuild optimization, not a replacement for history.

See the [package guide](../../packages/event-source/README.md) for lifecycle,
validation, failure handling, and how this differs from Vela live queries.
