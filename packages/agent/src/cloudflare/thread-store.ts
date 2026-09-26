import { DurableObject } from 'cloudflare:workers';
import type { AgentApprovalEvent, AgentRunResult } from '../types';
import type { AgentMessage, AgentThread, AgentThreadScope, AgentThreadStore } from '../store';
import { AgentError } from '../errors';
import { canonicalJson } from '../validation';
import {
  appendSchema,
  approvalSchema,
  challengeSchema,
  claimSchema,
  ensureSchema,
  finishSchema,
  messageSchema,
  patchSchema,
  resultSchema,
  scopeSchema,
  threadSchema,
} from './schemas';

export interface DurableAgentThreadStore extends AgentThreadStore {
  /** Caller must authenticate/authorize the approver before recording. Write
   * first, then sendEvent; repeating an identical decision is idempotent. */
  recordApproval(scope: AgentThreadScope, event: AgentApprovalEvent): Promise<void>;
  /** Compare a delivered event with the authenticated durable decision. Safe to
   * repeat if the native verification step crashes before checkpointing. */
  verifyApproval(scope: AgentThreadScope, event: AgentApprovalEvent): Promise<boolean>;
}

type ThreadRow = { data: string; active_run: string | null };
type RunRow = { instance_id: string; input_digest: string; result: string | null };

function conflict(message: string): never {
  throw new AgentError('AGENT_RUN_CONFLICT', message, { status: 409 });
}
function denied(): never {
  throw new AgentError('AGENT_THREAD_SCOPE_MISMATCH', 'Thread scope does not match', {
    status: 403,
  });
}

/** One SQLite Durable Object per thread. Access is a service-binding capability:
 * never expose arbitrary RPC input to the public without verified identity.
 * Every operation compares immutable scope inside its synchronous transaction.
 * No timers, automatic claim expiry, or external I/O occurs in a transaction. */
export class AgentThreadDurableObject
  extends DurableObject<unknown>
  implements DurableAgentThreadStore
{
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS agent_thread (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), data TEXT NOT NULL, active_run TEXT
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
        run_key TEXT PRIMARY KEY, instance_id TEXT NOT NULL, input_digest TEXT NOT NULL, result TEXT
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS agent_messages (
        message_key TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, data TEXT NOT NULL
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS agent_challenges (
        nonce TEXT PRIMARY KEY, data TEXT NOT NULL, decision TEXT
      )`);
    });
  }

  #transaction<T>(operation: () => T): T {
    return this.ctx.storage.transactionSync(operation);
  }

  #scoped(scope: AgentThreadScope): { thread: AgentThread; activeRun: string | null } {
    scopeSchema.strict().parse(scope);
    const row = this.ctx.storage.sql
      .exec<ThreadRow>('SELECT data, active_run FROM agent_thread WHERE singleton = 1')
      .toArray()[0];
    if (!row) return denied();
    // JSON is written only after schema and finite JSON validation. Parse again
    // on reads to fail closed on incompatible/corrupt stored records.
    const thread = threadSchema.parse(JSON.parse(row.data)) as AgentThread;
    if (
      thread.threadKey !== scope.threadKey ||
      thread.agent !== scope.agent ||
      thread.ownerId !== scope.ownerId ||
      thread.tenantId !== scope.tenantId
    )
      denied();
    return { thread, activeRun: row.active_run };
  }

  #scope(input: AgentThreadScope): AgentThreadScope {
    return scopeSchema.parse(input);
  }

  #writeThread(thread: AgentThread): void {
    this.ctx.storage.sql.exec(
      'UPDATE agent_thread SET data = ? WHERE singleton = 1',
      canonicalJson(thread),
    );
  }

  async ensureThread(input: Parameters<AgentThreadStore['ensureThread']>[0]) {
    const checked = ensureSchema.parse(input);
    canonicalJson(checked);
    return this.#transaction(() => {
      const existing = this.ctx.storage.sql.exec('SELECT singleton FROM agent_thread').toArray()[0];
      if (existing) return { created: false, thread: this.#scoped(this.#scope(checked)).thread };
      const thread: AgentThread = {
        ...this.#scope(checked),
        status: 'running',
        messageCount: 0,
        ...(checked.title !== undefined ? { title: checked.title } : {}),
      };
      this.ctx.storage.sql.exec(
        'INSERT INTO agent_thread (singleton, data) VALUES (1, ?)',
        canonicalJson(thread),
      );
      return { created: true, thread };
    });
  }

  async claimRun(
    input: Parameters<AgentThreadStore['claimRun']>[0],
  ): Promise<AgentRunResult | undefined> {
    const checked = claimSchema.parse(input);
    return this.#transaction(() => {
      const state = this.#scoped(this.#scope(checked));
      const row = this.ctx.storage.sql
        .exec<RunRow>(
          'SELECT instance_id, input_digest, result FROM agent_runs WHERE run_key = ?',
          checked.runKey,
        )
        .toArray()[0];
      if (row && row.input_digest !== checked.inputDigest)
        conflict('runKey was already used with different input');
      if (row?.result !== null && row?.result !== undefined)
        return resultSchema.parse(JSON.parse(row.result)) as AgentRunResult;
      if (
        (row && row.instance_id !== checked.instanceId) ||
        (state.activeRun !== null && state.activeRun !== checked.runKey)
      )
        conflict('Thread already has an active workflow instance');
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO agent_runs (run_key, instance_id, input_digest) VALUES (?, ?, ?)',
        checked.runKey,
        checked.instanceId,
        checked.inputDigest,
      );
      this.ctx.storage.sql.exec(
        'UPDATE agent_thread SET active_run = ? WHERE singleton = 1',
        checked.runKey,
      );
      return undefined;
    });
  }

  async finishRun(input: Parameters<AgentThreadStore['finishRun']>[0]): Promise<void> {
    const checked = finishSchema.parse(input);
    const result = canonicalJson(checked.result);
    this.#transaction(() => {
      const state = this.#scoped(this.#scope(checked));
      const row = this.ctx.storage.sql
        .exec<RunRow>(
          'SELECT instance_id, input_digest, result FROM agent_runs WHERE run_key = ?',
          checked.runKey,
        )
        .toArray()[0];
      if (!row || row.instance_id !== checked.instanceId)
        conflict('Run is owned by another instance');
      if (row.result !== null) {
        if (row.result !== result) conflict('Completed run result cannot change');
        return;
      }
      if (state.activeRun !== checked.runKey) conflict('Run no longer owns this thread');
      this.ctx.storage.sql.exec(
        'UPDATE agent_runs SET result = ? WHERE run_key = ?',
        result,
        checked.runKey,
      );
      this.ctx.storage.sql.exec('UPDATE agent_thread SET active_run = NULL WHERE singleton = 1');
    });
  }

  async appendMessage(input: Parameters<AgentThreadStore['appendMessage']>[0]) {
    const checked = appendSchema.parse(input);
    canonicalJson(checked);
    return this.#transaction(() => {
      const { thread, activeRun } = this.#scoped(this.#scope(checked));
      const existing = this.ctx.storage.sql
        .exec<{ seq: number }>(
          'SELECT seq FROM agent_messages WHERE message_key = ?',
          checked.messageKey,
        )
        .toArray()[0];
      if (existing) return { seq: existing.seq, deduped: true };
      const {
        threadKey: _thread,
        agent: _agent,
        ownerId: _owner,
        tenantId: _tenant,
        messageKey,
        ...draft
      } = checked;
      const message = { ...draft, seq: thread.messageCount };
      if (checked.approval) {
        const challenge = checked.approval;
        if (
          challenge.threadKey !== thread.threadKey ||
          challenge.ownerId !== thread.ownerId ||
          challenge.tenantId !== thread.tenantId ||
          activeRun !== challenge.runKey
        )
          denied();
        const run = this.ctx.storage.sql
          .exec<{ instance_id: string }>(
            'SELECT instance_id FROM agent_runs WHERE run_key = ?',
            challenge.runKey,
          )
          .one();
        if (run.instance_id !== challenge.instanceId)
          conflict('Approval belongs to another instance');
        this.ctx.storage.sql.exec(
          'INSERT INTO agent_challenges (nonce, data) VALUES (?, ?)',
          challenge.nonce,
          canonicalJson(challenge),
        );
      }
      this.ctx.storage.sql.exec(
        'INSERT INTO agent_messages (message_key, seq, data) VALUES (?, ?, ?)',
        messageKey,
        message.seq,
        canonicalJson(message),
      );
      thread.messageCount += 1;
      this.#writeThread(thread);
      return { seq: message.seq, deduped: false };
    });
  }

  async listMessages(input: AgentThreadScope): Promise<ReadonlyArray<AgentMessage>> {
    return this.#transaction(() => {
      this.#scoped(input);
      return this.ctx.storage.sql
        .exec<{ data: string }>('SELECT data FROM agent_messages ORDER BY seq')
        .toArray()
        .map((row) => messageSchema.parse(JSON.parse(row.data)) as AgentMessage);
    });
  }

  async patchThread(input: Parameters<AgentThreadStore['patchThread']>[0]): Promise<void> {
    const checked = patchSchema.parse(input);
    canonicalJson(checked);
    this.#transaction(() => {
      const { thread } = this.#scoped(this.#scope(checked));
      if (checked.status !== undefined) {
        thread.status = checked.status;
        if (checked.status !== 'error') delete thread.error;
      }
      if (checked.error !== undefined) thread.error = checked.error;
      if (checked.usage !== undefined)
        thread.usage = checked.usage as NonNullable<AgentThread['usage']>;
      this.#writeThread(thread);
    });
  }

  async recordApproval(scope: AgentThreadScope, event: AgentApprovalEvent): Promise<void> {
    const checked = approvalSchema.parse(event);
    const decision = canonicalJson(checked);
    this.#transaction(() => {
      const { activeRun } = this.#scoped(scope);
      const row = this.ctx.storage.sql
        .exec<{ data: string; decision: string | null }>(
          'SELECT data, decision FROM agent_challenges WHERE nonce = ?',
          checked.nonce,
        )
        .toArray()[0];
      const { decision: _decision, approverId: _approver, note: _note, ...challenge } = checked;
      if (!row || row.data !== canonicalJson(challengeSchema.parse(challenge))) denied();
      if (row.decision !== null) {
        if (row.decision !== decision) conflict('Approval decision cannot change');
        return;
      }
      if (activeRun !== checked.runKey || checked.expiresAt <= Date.now())
        conflict('Approval is expired or its run is inactive');
      this.ctx.storage.sql.exec(
        'UPDATE agent_challenges SET decision = ? WHERE nonce = ?',
        decision,
        checked.nonce,
      );
    });
  }

  async verifyApproval(scope: AgentThreadScope, event: AgentApprovalEvent): Promise<boolean> {
    const checked = approvalSchema.parse(event);
    const decision = canonicalJson(checked);
    return this.#transaction(() => {
      this.#scoped(scope);
      const row = this.ctx.storage.sql
        .exec<{ decision: string | null }>(
          'SELECT decision FROM agent_challenges WHERE nonce = ?',
          checked.nonce,
        )
        .toArray()[0];
      return row?.decision === decision;
    });
  }
}

/** Resolve a stub for each call from the supplied environment's namespace.
 * Object names use only threadKey: changing a selector cannot create a second
 * scope for an already owned thread. Namespace access is trusted server-only. */
export function durableAgentThreadStore(
  namespace: DurableObjectNamespace<AgentThreadDurableObject>,
): DurableAgentThreadStore {
  const stub = (scope: AgentThreadScope) => {
    const checked = scopeSchema.parse(scope);
    return namespace.get(namespace.idFromName(checked.threadKey));
  };
  return {
    ensureThread: async (input) => stub(input).ensureThread(input),
    claimRun: async (input) => stub(input).claimRun(input),
    finishRun: async (input) => stub(input).finishRun(input),
    appendMessage: async (input) => stub(input).appendMessage(input),
    listMessages: async (input) => stub(input).listMessages(input),
    patchThread: async (input) => stub(input).patchThread(input),
    recordApproval: async (scope, event) => stub(scope).recordApproval(scope, event),
    verifyApproval: async (scope, event) => stub(scope).verifyApproval(scope, event),
  };
}
