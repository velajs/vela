import type { AgentApprovalEvent, AgentRunResult } from './types';

/** BYO scoped persistence. Production adapters must serialize authorization,
 * run claims, completion and message sequence allocation. Message deduplication
 * alone does not prevent duplicate remote effects. */

/** Token counts accrued across a run's model turns. All fields optional — a provider may omit any. */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** The author of a stored message. */
export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

/** Lifecycle marker on a tool message that passed through the approval gate. */
export type AgentMessageStatus = 'awaiting_approval' | 'approved' | 'rejected';

/** A single tool invocation the model asked for (assistant intent). */
export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** One persisted message row, ordered within its thread by {@link AgentMessage.seq}. */
export interface AgentMessage {
  /** Monotonic, gap-free per-thread sequence number (allocated by the store). */
  seq: number;
  role: AgentRole;
  content: string;
  /** Present on an assistant message that carries tool-call intent. */
  toolCalls?: ReadonlyArray<AgentToolCall>;
  /** Present on a tool-result message: the id/name of the call it answers. */
  toolCallId?: string;
  toolName?: string;
  /** Present on a tool message that went through the approval gate. */
  status?: AgentMessageStatus;
  /** Persisted challenge, recoverable even when the live event is missed. */
  approval?: Omit<AgentApprovalEvent, 'decision' | 'approverId' | 'note'>;
}

/** The payload handed to {@link AgentThreadStore.appendMessage}. */
export interface AppendMessageInput extends AgentThreadScope {
  /**
   * The idempotency key for this message within the thread. A second append with
   * an already-seen `messageKey` is a no-op that returns the original `seq`.
   */
  messageKey: string;
  role: AgentRole;
  content: string;
  toolCalls?: ReadonlyArray<AgentToolCall>;
  toolCallId?: string;
  toolName?: string;
  status?: AgentMessageStatus;
  /** Persisted challenge, recoverable even when the live event is missed. */
  approval?: Omit<AgentApprovalEvent, 'decision' | 'approverId' | 'note'>;
}

/** The outcome of an {@link AgentThreadStore.appendMessage}. */
export interface AppendResult {
  /** The row's sequence number — freshly allocated, or the original on a dedup. */
  seq: number;
  /** True when the `messageKey` was already present, so nothing was written. */
  deduped: boolean;
}

/** Lifecycle state of a thread. */
export type AgentThreadStatus = 'running' | 'idle' | 'error' | 'awaiting_input';

/** The thread header row. */
export interface AgentThread {
  threadKey: string;
  agent: string;
  status: AgentThreadStatus;
  messageCount: number;
  ownerId: string;
  tenantId: string;
  title?: string;
  error?: string;
  usage?: AgentUsage;
}

/**
 * Immutable authorization scope for a thread. Persistence adapters must compare
 * every field inside the same transaction as the requested read or write and
 * reject blank/non-canonical identity values.
 */
export interface AgentThreadScope {
  threadKey: string;
  agent: string;
  ownerId: string;
  tenantId: string;
}

/** A read-only view of a thread's messages, handed to a tool's `execute`. */
export interface AgentThreadReader {
  list(): Promise<ReadonlyArray<AgentMessage>>;
}

/**
 * The bring-your-own thread-persistence seam. Every method carries the complete
 * agent/owner/tenant scope. Adapters MUST compare that scope and perform the
 * requested operation atomically; `threadKey` alone is never authorization.
 * `ownerId` and `tenantId` must be non-empty canonical values derived by the
 * runtime identity resolver.
 */
export interface AgentThreadStore {
  /**
   * Get-or-create the thread header. MUST be idempotent by `threadKey`: the first
   * writer sets `agent`/`ownerId`/`tenantId`/`title`, and a re-entry returns the
   * existing row.
   * Concurrency and delivery deduplication are enforced by `claimRun`, before
   * any model or tool call. Returns `{ created }`.
   */
  ensureThread(
    input: AgentThreadScope & {
      runKey: string;
      title?: string;
    },
  ): Promise<{ created: boolean; thread: AgentThread }>;

  /**
   * Atomically bind (thread, runKey) to one instance and input digest. Return the
   * stored result for a completed duplicate; reject changed input, a different
   * active instance, or another active run on this thread. Same-instance replay
   * is allowed. Retain completed claims for the application's deduplication period.
   */
  claimRun(
    input: AgentThreadScope & {
      runKey: string;
      instanceId: string;
      inputDigest: string;
    },
  ): Promise<AgentRunResult | undefined>;

  /** Atomically record completion and release the thread's active run claim. */
  finishRun(
    input: AgentThreadScope & {
      runKey: string;
      instanceId: string;
      result: AgentRunResult;
    },
  ): Promise<void>;

  /**
   * Append one message. MUST be ATOMIC and IDEMPOTENT on the composite key
   * `(threadKey, messageKey)`: implement it as an insert guarded by a
   * `UNIQUE(threadKey, messageKey)` constraint, or as a read-then-insert inside a
   * serialized transaction. `seq` MUST be allocated from a monotonic per-thread
   * counter (the thread's `messageCount`) INSIDE that same serialized mutation,
   * so allocation is O(1) and gap-free. A second append with an already-seen
   * `messageKey` MUST write NOTHING and return the original `seq` with
   * `deduped: true`.
   *
   * This is the invariant that makes at-least-once workflow delivery safe: a
   * replayed or duplicate-delivered persist appends nothing.
   */
  appendMessage(input: AppendMessageInput): Promise<AppendResult>;

  /** All messages of a thread, ordered by `seq` ascending. */
  listMessages(input: AgentThreadScope): Promise<ReadonlyArray<AgentMessage>>;

  /** Patch the thread header's status / error / usage. */
  patchThread(
    input: AgentThreadScope & {
      status?: AgentThreadStatus;
      error?: string;
      usage?: AgentUsage;
    },
  ): Promise<void>;
}
