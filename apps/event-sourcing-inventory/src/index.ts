import {
  defineEvents,
  payload,
  EventLog,
  defineMaterializer,
  MaterializerRuntime,
  InMemorySnapshotStore,
} from '@velajs/event-source';

// Each instance belongs to one inventory stream, for one tenant/environment.
const events = defineEvents({
  inventory: { received: payload<number>(), reserved: payload<number>() },
});
const log = new EventLog();
const store = new InMemorySnapshotStore();

function quantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Expected a non-negative integer quantity');
  }
  return value;
}

function availableStock() {
  return defineMaterializer({
    name: 'available-v1',
    initial: () => 0,
    parseSnapshot: quantity,
    handle: (state, entry) => {
      if (entry.type === events.inventory.received.type) return state + quantity(entry.payload);
      if (entry.type === events.inventory.reserved.type) {
        const next = state - quantity(entry.payload);
        if (next < 0) throw new Error('History reserves more stock than was received');
        return next;
      }
      return state;
    },
  });
}

// Factories infer payload types, but boundary validation remains explicit.
const receivedFromRequest: unknown = 10;
log.append(events.inventory.received(quantity(receivedFromRequest)));
log.append(events.inventory.reserved(3));
const first = availableStock();
const runtime = new MaterializerRuntime([first], {
  snapshotStore: store,
  snapshotKey: 'tenant-a/stock/v1',
});
runtime.catchUp(log);
await runtime.persistSnapshots();

// The durable adapter would persist the domain log separately. A projection
// snapshot alone cannot recover events written after that snapshot.
const persistedHistory: unknown = JSON.parse(JSON.stringify(log.snapshot()));
const restartedLog = new EventLog();
restartedLog.load(persistedHistory);
restartedLog.append(events.inventory.received(5));
const restarted = availableStock();
const resumed = new MaterializerRuntime([restarted], {
  snapshotStore: store,
  snapshotKey: 'tenant-a/stock/v1',
});
const replayedTail = await resumed.bootstrap(restartedLog);
if (replayedTail !== 1 || restarted.state !== 12) throw new Error('Checkpoint recovery failed');
if (resumed.applyEntries(restartedLog.getSince(0)) !== 0)
  throw new Error('Duplicate delivery changed stock');

// Add a new projection later: the current balance cannot tell us how much was
// received in total, but the retained business events can rebuild that answer.
const received = defineMaterializer({
  name: 'total-received-v1',
  initial: () => 0,
  handle: (state, entry) =>
    entry.type === events.inventory.received.type ? state + quantity(entry.payload) : state,
});
const audit = new MaterializerRuntime([received], { unknownEventHandling: 'ignore' });
audit.catchUp(restartedLog);
if (received.state !== 15) throw new Error('Historical projection failed');

// An application can now invalidate its inventory live-query tag after the
// domain write/projection has committed. Live cursor numbers are unrelated.
// oxlint-disable-next-line no-console
console.log(
  JSON.stringify({ available: restarted.state, totalReceived: received.state, replayedTail }),
);
