import type {
  ReliabilityStore,
  ReliabilitySession,
  ReliabilityScope,
  WorkKey,
  WorkRecord,
} from '../types';
import { scope as validateScope, decodeRecord, integer } from '../validation';
import { due, owned, transitionValues } from '../state';

const key = (value: WorkKey) =>
  JSON.stringify([value.tenantId, value.namespace, value.kind, value.id]);
const matches = (row: ReliabilityScope, scope: ReliabilityScope) =>
  row.tenantId === scope.tenantId && row.namespace === scope.namespace;

/** Reference adapter only. Rows and locks vanish with this object; use SQL for durability. */
export function createMemoryReliabilityStore(
  options: { now?: () => number } = {},
): ReliabilityStore {
  let rows = new Map<string, WorkRecord>();
  let tail: Promise<void> = Promise.resolve();
  return {
    async run(scope, work) {
      let release!: () => void;
      const before = tail;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await before;
      try {
        validateScope(scope);
        const draft = new Map(rows);
        let active = true;
        const now = () => {
          if (!active) throw new TypeError('Expired reference store session');
          return integer((options.now ?? Date.now)(), 'clock');
        };
        const check = (value: ReliabilityScope) => {
          now();
          if (!matches(value, scope)) throw new TypeError('Store scope mismatch');
        };
        const save = (record: WorkRecord) => {
          const checked = decodeRecord(record);
          draft.set(key(checked), checked);
          return checked;
        };
        const session: ReliabilitySession = {
          atomic: true,
          now: async () => now(),
          get: async (selector) => {
            check(selector);
            return draft.get(key(selector)) ?? null;
          },
          insert: async (record) => {
            check(record);
            if (draft.has(key(record))) return null;
            return save(record);
          },
          due: async (selector, kind, limit) => {
            check(selector);
            return [...draft.values()]
              .filter((row) => matches(row, scope) && row.kind === kind && due(row, now()))
              .toSorted((a, b) => a.availableAt - b.availableAt || a.id.localeCompare(b.id))
              .slice(0, limit);
          },
          claim: async (record, token, leaseMs) => {
            check(record);
            const row = draft.get(key(record));
            const time = now();
            if (
              !row ||
              row.generation !== record.generation ||
              row.fingerprint !== record.fingerprint ||
              row.payload !== record.payload ||
              !due(row, time) ||
              row.attempt >= row.maxAttempts
            )
              return null;
            return save({
              ...row,
              state: 'leased',
              token,
              fence: row.fence + 1,
              revision: row.revision + 1,
              attempt: row.attempt + 1,
              leaseUntil: time + leaseMs,
              updatedAt: time,
            });
          },
          transition: async (claim, change) => {
            check(claim);
            const row = draft.get(key(claim));
            const time = now();
            if (!row || !owned(row, claim, time)) return null;
            return save({ ...row, ...transitionValues(row, change, time) });
          },
          exhaust: async (record) => {
            check(record);
            const row = draft.get(key(record));
            const time = now();
            if (
              row &&
              row.generation === record.generation &&
              due(row, time) &&
              row.attempt >= row.maxAttempts
            )
              save({
                ...row,
                state: 'failed',
                token: null,
                leaseUntil: null,
                error: 'attempts-exhausted',
                expiresAt: time + row.retentionMs,
                updatedAt: time,
                revision: row.revision + 1,
              });
          },
          edit: async (selector, generation, revision, action, dueAt) => {
            check(selector);
            const row = draft.get(key(selector));
            const time = now();
            if (
              !row ||
              row.generation !== generation ||
              row.revision !== revision ||
              (row.state !== 'pending' && row.state !== 'leased')
            )
              return null;
            return save({
              ...row,
              state: action === 'cancel' ? 'cancelled' : 'pending',
              token: null,
              leaseUntil: null,
              fence: row.fence + 1,
              revision: row.revision + 1,
              updatedAt: time,
              ...(action === 'cancel'
                ? { expiresAt: time + row.retentionMs }
                : { availableAt: integer(dueAt, 'dueAt') }),
            });
          },
          prune: async (selector, kind, limit) => {
            check(selector);
            let count = 0;
            const time = now();
            for (const [id, row] of draft)
              if (
                count < limit &&
                matches(row, scope) &&
                row.kind === kind &&
                row.expiresAt !== null &&
                row.expiresAt <= time &&
                ['completed', 'failed', 'cancelled'].includes(row.state)
              ) {
                draft.delete(id);
                count++;
              }
            return count;
          },
        };
        try {
          const result = await work(session);
          rows = draft;
          return result;
        } finally {
          active = false;
        }
      } finally {
        release();
      }
    },
  };
}
