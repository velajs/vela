import {
  ReliabilityError,
  ReliabilityClaimError,
  type ReliabilityScope,
  type WorkKey,
  type WorkRecord,
  type WorkKind,
  type Lease,
  type ClaimOutcome,
  type ReliabilitySession,
  type FeatureOptions,
  type PayloadOptions,
  type OperationOptions,
  type ClaimOptions,
  type Decoder,
} from './types';
import {
  DEFAULT_BYTES,
  MAX_BYTES,
  MAX_DURATION,
  encodeJson,
  decodeJson,
  fingerprint,
  integer,
  text,
  scope as validateScope,
  validateLease,
} from './validation';

const DAY = 86_400_000;
const recordKey = (scope: ReliabilityScope, kind: WorkKind, id: string): WorkKey => ({
  ...validateScope(scope),
  kind,
  id: text(id, 'id'),
});
function limits(options: ClaimOptions) {
  return {
    leaseMs: integer(options.leaseMs ?? 30_000, 'leaseMs', 1, 3_600_000),
    maxAttempts: integer(options.maxAttempts ?? 10, 'maxAttempts', 1, 1000),
    retentionMs: integer(options.retentionMs ?? 7 * DAY, 'retentionMs', 1, MAX_DURATION),
  };
}
export function newRecord(
  scope: ReliabilityScope,
  kind: WorkKind,
  id: string,
  payload: string,
  digest: string,
  now: number,
  options: ClaimOptions = {},
  dueAt = now,
): WorkRecord {
  const settings = limits(options);
  return Object.freeze({
    ...validateScope(scope),
    kind,
    id: text(id, 'id'),
    payload,
    fingerprint: text(digest, 'fingerprint', 256),
    generation: crypto.randomUUID(),
    state: 'pending',
    token: null,
    fence: 0,
    revision: 1,
    attempt: 0,
    maxAttempts: settings.maxAttempts,
    availableAt: integer(dueAt, 'dueAt'),
    createdAt: now,
    updatedAt: now,
    leaseUntil: null,
    retentionMs: settings.retentionMs,
    expiresAt: null,
    result: null,
    error: null,
  });
}
function engine<Tx>(options: FeatureOptions<Tx>) {
  const maxBytes = integer(
    options.maxPayloadBytes ?? DEFAULT_BYTES,
    'maxPayloadBytes',
    1,
    MAX_BYTES,
  );
  async function run<T>(
    scope: ReliabilityScope,
    operation: OperationOptions<Tx> | undefined,
    work: (session: ReliabilitySession) => Promise<T>,
  ): Promise<T> {
    let observation: ReturnType<NonNullable<FeatureOptions<Tx>['observer']>['onStart']> | undefined;
    try {
      observation = options.observer?.onStart();
      void Promise.resolve(observation).catch(() => undefined);
    } catch {
      /* Observers cannot change delivery outcomes. */
    }
    let outcome: 'success' | 'error' = 'error';
    try {
      const trusted = validateScope(scope);
      const result = await options.store.run(trusted, work, operation?.transaction);
      outcome = 'success';
      return result;
    } finally {
      try {
        const result: unknown = observation?.onEnd(outcome);
        void Promise.resolve(result).catch(() => undefined);
      } catch {
        /* Observers cannot change delivery outcomes. */
      }
    }
  }
  const lease = async <T>(record: WorkRecord, parse: Decoder<T>): Promise<Lease<T>> => {
    if (record.token === null || record.leaseUntil === null)
      throw new TypeError('Expected a stored lease');
    return Object.freeze({
      ...recordKey(record, record.kind, record.id),
      generation: record.generation,
      token: record.token,
      fence: record.fence,
      attempt: record.attempt,
      leaseUntil: record.leaseUntil,
      payload: await parse(decodeJson(record.payload, maxBytes)),
    });
  };
  async function acquire<T, Result>(
    session: ReliabilitySession,
    record: WorkRecord,
    leaseMs: number,
    parse: Decoder<T>,
    parseResult: Decoder<Result>,
  ): Promise<ClaimOutcome<T, Result>> {
    const now = await session.now();
    if (record.state === 'completed') {
      if (record.expiresAt !== null && record.expiresAt <= now) return { kind: 'expired' };
      if (record.result === null)
        throw new ReliabilityError('RESULT_UNAVAILABLE', 'Completed result is unavailable');
      return { kind: 'completed', value: await parseResult(decodeJson(record.result, maxBytes)) };
    }
    if (record.state === 'failed') return { kind: 'failed', reason: record.error ?? 'failed' };
    if (record.state === 'cancelled') return { kind: 'cancelled' };
    const retryAt = Math.max(record.availableAt, record.leaseUntil ?? 0);
    if (retryAt > now) return { kind: 'busy', retryAt };
    if (record.attempt >= record.maxAttempts) {
      await session.exhaust(record);
      return { kind: 'failed', reason: 'attempts-exhausted' };
    }
    // Validate persisted payload before acquiring any lease, including on nontransactional D1.
    const payload = await parse(decodeJson(record.payload, maxBytes));
    const acquired = await session.claim(record, crypto.randomUUID(), leaseMs);
    if (!acquired) {
      const latest = await session.get(record);
      return {
        kind: 'busy',
        retryAt: Math.max(now, latest?.availableAt ?? now, latest?.leaseUntil ?? now),
      };
    }
    return { kind: 'claimed', claim: await lease(acquired, () => payload) };
  }
  function controls(kind: WorkKind) {
    async function change<T>(
      claim: Lease<T>,
      transition: Parameters<ReliabilitySession['transition']>[1],
      operation?: OperationOptions<Tx>,
    ) {
      return run(claim, operation, async (session) => {
        validateLease(claim, kind);
        const row = await session.transition(claim, transition);
        if (!row)
          throw new ReliabilityError(
            'LEASE_LOST',
            'Lease expired, was superseded, or belongs to another scope',
          );
        return row;
      });
    }
    return {
      renew: <T>(claim: Lease<T>, leaseMs = 30_000, operation?: OperationOptions<Tx>) =>
        run(claim, operation, async (session) => {
          validateLease(claim, kind);
          integer(leaseMs, 'leaseMs', 1, 3_600_000);
          const row = await session.transition(claim, { state: 'leased', leaseMs });
          if (!row || !row.leaseUntil)
            throw new ReliabilityError('LEASE_LOST', 'Cannot renew an expired or superseded lease');
          return Object.freeze({ ...claim, leaseUntil: row.leaseUntil });
        }),
      retry: <T>(
        claim: Lease<T>,
        settings: { delayMs: number; error?: string },
        operation?: OperationOptions<Tx>,
      ) =>
        run(claim, operation, async (session) => {
          validateLease(claim, kind);
          integer(settings.delayMs, 'delayMs', 0, MAX_DURATION);
          const error =
            settings.error === undefined ? 'retry' : text(settings.error, 'error code', 512);
          const row = await session.transition(claim, {
            state: 'pending',
            delayMs: settings.delayMs,
            error,
          });
          if (!row)
            throw new ReliabilityError('LEASE_LOST', 'Cannot retry an expired or superseded lease');
          return row;
        }),
      fail: <T>(claim: Lease<T>, error = 'failed', operation?: OperationOptions<Tx>) =>
        run(claim, operation, async (session) => {
          validateLease(claim, kind);
          text(error, 'error code', 512);
          const row = await session.transition(claim, { state: 'failed', error });
          if (!row)
            throw new ReliabilityError('LEASE_LOST', 'Cannot fail an expired or superseded lease');
          return row;
        }),
      complete: <T>(claim: Lease<T>, operation?: OperationOptions<Tx>) =>
        change(claim, { state: 'completed', result: 'null' }, operation),
      get: (scope: ReliabilityScope, id: string, operation?: OperationOptions<Tx>) =>
        run(scope, operation, (session) => session.get(recordKey(scope, kind, id))),
      prune: (scope: ReliabilityScope, limit = 100, operation?: OperationOptions<Tx>) =>
        run(scope, operation, (session) =>
          session.prune(validateScope(scope), kind, integer(limit, 'limit', 1, 1000)),
        ),
    };
  }
  return { run, key: recordKey, lease, claim: acquire, controls, maxBytes };
}

export function createIdempotency<Result, Tx = never>(
  options: FeatureOptions<Tx> & { parseResult: Decoder<Result> },
) {
  const e = engine(options);
  const controls = e.controls('idempotency');
  return {
    ...controls,
    claim: (
      scope: ReliabilityScope,
      input: { key: string; fingerprint: string } & ClaimOptions,
      operation?: OperationOptions<Tx>,
    ) =>
      e.run(scope, operation, async (session) => {
        const settings = limits(input);
        const digest = text(input.fingerprint, 'fingerprint', 256);
        const key = e.key(scope, 'idempotency', input.key);
        let row = await session.get(key);
        if (!row)
          row =
            (await session.insert(
              newRecord(
                scope,
                'idempotency',
                input.key,
                'null',
                digest,
                await session.now(),
                settings,
              ),
            )) ?? (await session.get(key));
        if (!row)
          throw new ReliabilityError('CONFLICT', 'Idempotency record changed during admission');
        if (row.fingerprint !== digest) return { kind: 'conflict' } as const;
        return e.claim(session, row, settings.leaseMs, () => undefined, options.parseResult);
      }),
    complete: (claim: Lease, result: unknown, operation?: OperationOptions<Tx>) =>
      e.run(claim, operation, async (session) => {
        validateLease(claim, 'idempotency');
        const parsed = await options.parseResult(result);
        const encoded = encodeJson(parsed, e.maxBytes);
        const row = await session.transition(claim, { state: 'completed', result: encoded });
        if (!row)
          throw new ReliabilityError(
            'LEASE_LOST',
            'Cannot complete an expired or superseded lease',
          );
        return parsed;
      }),
    unavailable: (claim: Lease, operation?: OperationOptions<Tx>) =>
      controls.fail(claim, 'result-unavailable', operation),
  };
}

function delivery<T, Tx>(kind: 'outbox' | 'job', options: PayloadOptions<T, Tx>) {
  const e = engine(options);
  async function admit(
    scope: ReliabilityScope,
    input: { id: string; payload: unknown; dueAt?: number } & ClaimOptions,
    operation?: OperationOptions<Tx>,
  ) {
    return e.run(scope, operation, async (session) => {
      limits(input);
      const parsed = await options.parsePayload(input.payload);
      const payload = encodeJson(parsed, e.maxBytes);
      const now = await session.now();
      const dueAt = input.dueAt === undefined ? now : integer(input.dueAt, 'dueAt');
      // An omitted time is a stable admission request; explicit times are part of deduplication.
      const digest = await fingerprint(
        { payload: decodeJson(payload, e.maxBytes), dueAt: input.dueAt ?? null },
        Math.min(MAX_BYTES, e.maxBytes + 1024),
      );
      const record = newRecord(scope, kind, input.id, payload, digest, now, input, dueAt);
      const existing = (await session.insert(record)) ?? (await session.get(record));
      if (!existing || existing.fingerprint !== digest)
        throw new ReliabilityError('CONFLICT', 'Delivery id already has different content');
      return existing;
    });
  }
  return {
    ...e.controls(kind),
    admit,
    claimDue: (
      scope: ReliabilityScope,
      input: { limit?: number; leaseMs?: number } = {},
      operation?: OperationOptions<Tx>,
    ): Promise<Lease<T>[]> =>
      e.run(scope, operation, async (session) => {
        const limit = integer(input.limit ?? 10, 'limit', 1, 1000);
        const leaseMs = limits(input).leaseMs;
        const rows = await session.due(validateScope(scope), kind, limit);
        // Validate the entire candidate page before an autocommit backend spends any
        // attempt budget. A malformed later payload must not strand earlier claims.
        const candidates = await Promise.all(
          rows.map(async (record) => ({
            record,
            payload: await options.parsePayload(decodeJson(record.payload, e.maxBytes)),
          })),
        );
        const claims: Lease<T>[] = [];
        try {
          for (const candidate of candidates) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Shared native transactions require sequential claims.
            const result = await e.claim(
              session,
              candidate.record,
              leaseMs,
              () => candidate.payload,
              () => undefined,
            );
            if (result.kind === 'claimed') claims.push(result.claim);
          }
        } catch (cause) {
          if (!session.atomic) throw new ReliabilityClaimError(claims, cause);
          throw cause;
        }
        return claims;
      }),
  };
}
export function createOutbox<T, Tx = never>(options: PayloadOptions<T, Tx>) {
  const feature = delivery('outbox', options);
  const { admit, ...controls } = feature;
  return {
    ...controls,
    enqueue: (
      scope: ReliabilityScope,
      input: { id: string; payload: unknown; availableAt?: number } & ClaimOptions,
      operation?: OperationOptions<Tx>,
    ) =>
      admit(
        scope,
        { ...input, ...(input.availableAt === undefined ? {} : { dueAt: input.availableAt }) },
        operation,
      ),
    acknowledge: controls.complete,
  };
}
export function createScheduler<T, Tx = never>(options: PayloadOptions<T, Tx>) {
  const { admit, ...controls } = delivery('job', options);
  const e = engine(options);
  return {
    ...controls,
    schedule: (
      scope: ReliabilityScope,
      input: { id: string; payload: unknown; dueAt: number } & ClaimOptions,
      operation?: OperationOptions<Tx>,
    ) => admit(scope, input, operation),
    cancel: (
      scope: ReliabilityScope,
      input: { id: string; expectedGeneration: string; expectedRevision: number },
      operation?: OperationOptions<Tx>,
    ) =>
      e.run(scope, operation, async (session) => {
        const row = await session.edit(
          e.key(scope, 'job', input.id),
          text(input.expectedGeneration, 'generation', 128),
          integer(input.expectedRevision, 'revision', 1, Number.MAX_SAFE_INTEGER),
          'cancel',
        );
        if (!row)
          throw new ReliabilityError('REVISION_CONFLICT', 'Job changed or is already terminal');
        return row;
      }),
    reschedule: (
      scope: ReliabilityScope,
      input: { id: string; expectedGeneration: string; expectedRevision: number; dueAt: number },
      operation?: OperationOptions<Tx>,
    ) =>
      e.run(scope, operation, async (session) => {
        const row = await session.edit(
          e.key(scope, 'job', input.id),
          text(input.expectedGeneration, 'generation', 128),
          integer(input.expectedRevision, 'revision', 1, Number.MAX_SAFE_INTEGER),
          'reschedule',
          integer(input.dueAt, 'dueAt'),
        );
        if (!row)
          throw new ReliabilityError('REVISION_CONFLICT', 'Job changed or is already terminal');
        return row;
      }),
  };
}
export function createInbox<T, Tx = never>(options: PayloadOptions<T, Tx> & { consumer: string }) {
  const consumer = text(options.consumer, 'consumer', 256);
  const e = engine(options);
  const controls = e.controls('inbox');
  const id = (messageId: string) =>
    text(JSON.stringify([consumer, text(messageId, 'messageId', 256)]), 'inbox id');
  return {
    ...controls,
    get: (scope: ReliabilityScope, messageId: string, operation?: OperationOptions<Tx>) =>
      controls.get(scope, id(messageId), operation),
    claim: (
      scope: ReliabilityScope,
      input: { messageId: string; payload: unknown; fingerprint: string } & ClaimOptions,
      operation?: OperationOptions<Tx>,
    ) =>
      e.run(scope, operation, async (session) => {
        const settings = limits(input);
        const payload = encodeJson(await options.parsePayload(input.payload), e.maxBytes);
        const digest = text(input.fingerprint, 'fingerprint', 256);
        const key = e.key(scope, 'inbox', id(input.messageId));
        let row = await session.get(key);
        if (!row)
          row =
            (await session.insert(
              newRecord(scope, 'inbox', key.id, payload, digest, await session.now(), settings),
            )) ?? (await session.get(key));
        if (!row) throw new ReliabilityError('CONFLICT', 'Inbox changed during admission');
        if (row.fingerprint !== digest || row.payload !== payload)
          return { kind: 'conflict' } as const;
        return e.claim(session, row, settings.leaseMs, options.parsePayload, () => undefined);
      }),
  };
}
