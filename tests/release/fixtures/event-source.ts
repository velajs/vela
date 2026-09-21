import {
  EventLog,
  EventSource,
  EventEmitter,
  SubscriptionManager,
  InMemorySnapshotStore,
  MaterializerRuntime,
  defineMaterializer,
  defineEvents,
  payload,
  isInputEvent,
  isClientSeq,
  isGlobalSeq,
  createTableDiff,
  diffSize,
  isDiffEmpty,
  mergeDiffs,
  partitionChanges,
  applyDiff,
  applyDiffs,
  applyDiffToSnapshot,
  type EventLogEntry,
  type SnapshotStore,
  type EntrySource,
  type MaterializerDef,
  type RowMap,
  type InputEvent,
} from '@velajs/event-source';

function check(condition: boolean): void {
  if (!condition) throw new Error('Packed public API check failed');
}
const vocabulary = defineEvents({ stock: { received: payload<number>() } });
const event: InputEvent<'stock.received', number> = vocabulary.stock.received(2);
const history = new EventLog();
const entry: EventLogEntry = history.append(event);
const replayable: EntrySource = history;
const definition: MaterializerDef<number> = {
  name: 'count',
  initial: () => 0,
  handle: (state) => state + 1,
  parseSnapshot: (value) => {
    if (typeof value !== 'number') throw new TypeError('Invalid snapshot');
    return value;
  },
};
const view = defineMaterializer(definition);
const store: SnapshotStore = new InMemorySnapshotStore();
const runtime = new MaterializerRuntime([view], { snapshotStore: store });
runtime.catchUp(replayable);
await runtime.persistSnapshots();
check((await runtime.bootstrap(history)) === 0 && view.state === 1);
const loaded: unknown = JSON.parse(JSON.stringify(history.snapshot()));
new EventLog().load(loaded);
const source = new EventSource({ count: 0 }, (state) => ({ count: state.count + 1 }));
source.replayFrom(history);
check(source.state.count === 1);
check(
  isInputEvent(event) &&
    isGlobalSeq(entry.seq) &&
    isClientSeq({ client: 0, global: 0, rebaseGeneration: 0 }),
);
const emitter = new EventEmitter<{ count: number }>();
let observed = 0;
const dispose = emitter.on('count', (value) => {
  observed = value;
});
emitter.emit('count', 3);
dispose();
check(observed === 3 && !emitter.hasListeners('count'));
const subscriptions = new SubscriptionManager();
const unsubscribe = subscriptions.onEvent(entry.type, () => {
  observed += 1;
});
subscriptions.notifyEvent(entry);
unsubscribe();
check(observed === 4 && subscriptions.size === 0);
const diff = createTableDiff('stock', [{ op: 'insert', key: 'x', row: { quantity: 2 } }]);
const rows: RowMap = new Map();
check(diffSize(diff) === 1 && !isDiffEmpty(diff) && partitionChanges(diff).inserts.length === 1);
check(mergeDiffs([diff])?.table === 'stock');
check(applyDiff(rows, diff).get('x')?.quantity === 2);
check(applyDiffs(rows, [diff]).size === 1);
check(applyDiffToSnapshot(new Map(), diff).get('stock')?.size === 1);
