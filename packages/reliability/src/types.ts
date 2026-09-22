export interface ReliabilityScope {
  readonly tenantId: string;
  readonly namespace: string;
}
export type Decoder<T> = (value: unknown) => T | Promise<T>;
export type WorkKind = 'idempotency' | 'outbox' | 'inbox' | 'job';
export type WorkState = 'pending' | 'leased' | 'completed' | 'failed' | 'cancelled';
export interface ExecutionObserver {
  onStart(): { onEnd(outcome: 'success' | 'error' | 'cancelled'): void };
}
export interface WorkKey extends ReliabilityScope {
  readonly kind: WorkKind;
  readonly id: string;
}
/** Durable adapter format. All columns are validated before use. Times are epoch milliseconds. */
export interface WorkRecord extends WorkKey {
  readonly generation: string;
  readonly fingerprint: string;
  readonly payload: string;
  readonly state: WorkState;
  readonly token: string | null;
  readonly fence: number;
  readonly revision: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly availableAt: number;
  readonly leaseUntil: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly retentionMs: number;
  readonly expiresAt: number | null;
  readonly result: string | null;
  readonly error: string | null;
}
/** A lease fences database transitions; it cannot fence external side effects. */
export interface Lease<T = unknown> extends WorkKey {
  readonly generation: string;
  readonly token: string;
  readonly fence: number;
  readonly attempt: number;
  readonly leaseUntil: number;
  readonly payload: T;
}
export type ClaimOutcome<T, Result = void> =
  | { readonly kind: 'claimed'; readonly claim: Lease<T> }
  | { readonly kind: 'busy'; readonly retryAt: number }
  | { readonly kind: 'completed'; readonly value: Result }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'cancelled' };
export interface Transition {
  readonly state: WorkState;
  readonly leaseMs?: number;
  readonly delayMs?: number;
  readonly result?: string;
  readonly error?: string;
}
/** Trusted adapter seam. claim/transition/edit must be native compare-and-set operations. */
export interface ReliabilitySession {
  /** Rejection rolls back this entire session, including validation failures. */
  readonly atomic: boolean;
  now(): Promise<number>;
  get(key: WorkKey): Promise<WorkRecord | null>;
  insert(record: WorkRecord): Promise<WorkRecord | null>;
  due(scope: ReliabilityScope, kind: WorkKind, limit: number): Promise<WorkRecord[]>;
  claim(record: WorkRecord, token: string, leaseMs: number): Promise<WorkRecord | null>;
  transition(claim: Lease, change: Transition): Promise<WorkRecord | null>;
  exhaust(record: WorkRecord): Promise<void>;
  edit(
    key: WorkKey,
    generation: string,
    revision: number,
    action: 'cancel' | 'reschedule',
    dueAt?: number,
  ): Promise<WorkRecord | null>;
  prune(scope: ReliabilityScope, kind: WorkKind, limit: number): Promise<number>;
}
/** Tx is inferred from the selected adapter; portable declarations import no framework token. */
export interface ReliabilityStore<Tx = never> {
  run<T>(
    scope: ReliabilityScope,
    work: (session: ReliabilitySession) => Promise<T>,
    transaction?: Tx,
  ): Promise<T>;
}
export interface FeatureOptions<Tx> {
  readonly store: ReliabilityStore<Tx>;
  readonly maxPayloadBytes?: number;
  readonly observer?: ExecutionObserver;
}
export interface PayloadOptions<T, Tx> extends FeatureOptions<Tx> {
  readonly parsePayload: Decoder<T>;
}
export interface OperationOptions<Tx> {
  readonly transaction?: Tx;
}
export interface ClaimOptions {
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly retentionMs?: number;
}
export class ReliabilityError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'CONFLICT'
      | 'LEASE_LOST'
      | 'REVISION_CONFLICT'
      | 'UNSUPPORTED'
      | 'RESULT_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'ReliabilityError';
  }
}
/** A native statement committed before its returned row failed validation. */
export class ReliabilityResultError extends Error {
  readonly committed = true;
  constructor(cause: unknown) {
    super('Reliability statement committed, but result validation failed', { cause });
    this.name = 'ReliabilityResultError';
  }
}
/** Polling failed after native claims may have committed. Handlers have not run. */
export class ReliabilityClaimError<T = unknown> extends Error {
  readonly recoveryRequired = true;
  readonly committed: true | undefined;
  readonly claims: readonly Lease<T>[];
  constructor(claims: readonly Lease<T>[], cause: unknown) {
    super('Claim polling failed; recover outstanding leases before retrying delivery', { cause });
    this.name = 'ReliabilityClaimError';
    this.claims = Object.freeze([...claims]);
    this.committed = claims.length || cause instanceof ReliabilityResultError ? true : undefined;
  }
}
