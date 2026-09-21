# @velajs/event-source

## 1.0.1

### Patch Changes

- e45b6fe: Bring the optional, zero-dependency domain event-sourcing runtime into the monorepo
  on the 1.x line. Preserve its root exports and table-patch helpers, validate log
  boundaries and projection snapshots, make batches atomic, and fix replay lineage,
  rollback, checkpoint save ordering, and subscription delivery/cleanup. Checkpoint
  resume now requires a source epoch; persisted materializers need parseSnapshot to
  restore state. Add architecture guidance and a runnable inventory-history example.

## 0.1.0

- Initial release.
