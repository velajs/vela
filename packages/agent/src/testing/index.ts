/**
 * `@velajs/agent/testing` — in-memory doubles and a replay harness for driving
 * agents without a model or a platform runtime.
 *
 *  - {@link memoryThreadStore} — the reference {@link AgentThreadStore}, deduping on
 *    `(threadKey, messageKey)` with an O(1) per-thread counter, plus a `getThread`
 *    inspector for assertions.
 *  - {@link memoryRag} — a {@link RagLike} double returning a fixed context.
 *  - {@link scriptedGenerate} — an {@link AgentGenerate} keyed on the loop's
 *    0-based turn index passed by the runtime, so scripts stay aligned across
 *    replays and duplicate deliveries alike.
 *  - {@link createAgentHarness} — `compileAgent` over `@velajs/workflow/harness`.
 */
import { createReplayHarness } from '@velajs/workflow/harness';
import type { HarnessEvent, HarnessResult, ReplayHarness } from '@velajs/workflow/harness';
import type { WorkflowDefinition, WorkflowRunFunction } from '@velajs/workflow';

import { AgentError } from '../errors';
import { compileAgent } from '../compile-agent';
import type { AgentGenerate, AgentGenerateResult } from '../generate';
import type { AgentDefinition, AgentRunParams, AgentRunResult, RagLike } from '../types';
import type {
  AgentMessage,
  AgentThread,
  AgentThreadScope,
  AgentThreadStore,
  AgentToolCall,
} from '../store';

/** The reference store plus a `getThread` inspector (for test assertions). */
export interface MemoryThreadStore extends AgentThreadStore {
  /** Read the current thread header (a copy), or `undefined` if the thread is absent. */
  getThread(scope: AgentThreadScope): AgentThread | undefined;
}

interface ThreadState {
  row: AgentThread;
  byKey: Map<string, AgentMessage>;
  order: AgentMessage[];
  runs: Map<string, { instanceId: string; inputDigest: string; result?: AgentRunResult }>;
  activeRun?: string;
}

/**
 * The in-memory reference {@link AgentThreadStore}. `appendMessage` dedups on the
 * composite `(threadKey, messageKey)` key and allocates `seq` from the thread's
 * `messageCount` counter — the exact discipline a DO-SQLite adapter would enforce
 * with a `UNIQUE` index and a counter column.
 */
export const memoryThreadStore = (): MemoryThreadStore => {
  const threads = new Map<string, ThreadState>();

  const assertScope = (scope: AgentThreadScope): void => {
    if (
      typeof scope.ownerId !== 'string' ||
      scope.ownerId.length === 0 ||
      scope.ownerId !== scope.ownerId.trim() ||
      typeof scope.tenantId !== 'string' ||
      scope.tenantId.length === 0 ||
      scope.tenantId !== scope.tenantId.trim()
    ) {
      throw new Error('Thread scope requires a non-empty canonical ownerId and tenantId.');
    }
  };

  const scopedState = (scope: AgentThreadScope): ThreadState => {
    assertScope(scope);
    const state = threads.get(scope.threadKey);
    if (
      state === undefined ||
      state.row.agent !== scope.agent ||
      state.row.ownerId !== scope.ownerId ||
      state.row.tenantId !== scope.tenantId
    ) {
      throw new Error('Thread scope does not match the existing owner, tenant, or agent.');
    }
    return state;
  };

  return {
    ensureThread: async ({ threadKey, agent, ownerId, tenantId, title }) => {
      assertScope({ threadKey, agent, ownerId, tenantId });
      const existing = threads.get(threadKey);

      if (existing !== undefined) {
        if (
          existing.row.agent !== agent ||
          existing.row.ownerId !== ownerId ||
          existing.row.tenantId !== tenantId
        ) {
          throw new Error('Thread scope does not match the existing owner, tenant, or agent.');
        }
        return { created: false, thread: structuredClone(existing.row) };
      }

      const row: AgentThread = {
        threadKey,
        agent,
        ownerId,
        tenantId,
        status: 'running',
        messageCount: 0,
      };

      if (title !== undefined) {
        row.title = title;
      }

      threads.set(threadKey, { row, byKey: new Map(), order: [], runs: new Map() });

      return { created: true, thread: { ...row } };
    },

    claimRun: async (input) => {
      const state = scopedState(input);
      const claim = state.runs.get(input.runKey);
      if (claim && claim.inputDigest !== input.inputDigest) {
        throw new AgentError('AGENT_RUN_CONFLICT', 'runKey was already used with different input', {
          status: 409,
        });
      }
      if (claim?.result) return structuredClone(claim.result);
      if (
        (claim && claim.instanceId !== input.instanceId) ||
        (state.activeRun !== undefined && state.activeRun !== input.runKey)
      ) {
        throw new AgentError(
          'AGENT_RUN_CONFLICT',
          'thread already has an active workflow instance',
          { status: 409 },
        );
      }
      state.runs.set(input.runKey, {
        instanceId: input.instanceId,
        inputDigest: input.inputDigest,
      });
      state.activeRun = input.runKey;
      return undefined;
    },

    finishRun: async (input) => {
      const state = scopedState(input);
      const claim = state.runs.get(input.runKey);
      if (!claim || claim.instanceId !== input.instanceId) {
        throw new AgentError('AGENT_RUN_CONFLICT', 'run is owned by another instance', {
          status: 409,
        });
      }
      claim.result = structuredClone(input.result);
      if (state.activeRun === input.runKey) delete state.activeRun;
    },

    appendMessage: async (input) => {
      const state = scopedState(input);
      const seen = state.byKey.get(input.messageKey);

      // Idempotent on messageKey: a second append writes nothing.
      if (seen !== undefined) {
        return { seq: seen.seq, deduped: true };
      }

      const seq = state.row.messageCount;
      const message: AgentMessage = { seq, role: input.role, content: input.content };

      if (input.toolCalls !== undefined) {
        message.toolCalls = structuredClone(input.toolCalls);
      }

      if (input.toolCallId !== undefined) {
        message.toolCallId = input.toolCallId;
      }

      if (input.toolName !== undefined) {
        message.toolName = input.toolName;
      }

      if (input.status !== undefined) {
        message.status = input.status;
      }

      if (input.approval !== undefined) message.approval = structuredClone(input.approval);
      state.byKey.set(input.messageKey, message);
      state.order.push(message);
      state.row.messageCount += 1;

      return { seq, deduped: false };
    },

    listMessages: async (scope) => {
      const state = scopedState(scope);
      return state.order.map((message) => structuredClone(message));
    },

    patchThread: async (input) => {
      const state = scopedState(input);
      if (input.status !== undefined) {
        state.row.status = input.status;
        if (input.status !== 'error') delete state.row.error;
      }
      if (input.error !== undefined) state.row.error = input.error;
      if (input.usage !== undefined) state.row.usage = structuredClone(input.usage);
    },

    getThread: (scope) => {
      const state = threads.get(scope.threadKey);
      if (state === undefined) return undefined;
      return structuredClone(scopedState(scope).row);
    },
  };
};

/** Options for the {@link memoryRag} double. */
export interface MemoryRagOptions {
  context?: string;
  chunks?: ReadonlyArray<unknown>;
  sources?: ReadonlyArray<unknown>;
}

/** The {@link RagLike} double plus a `queries` inspector. */
export interface MemoryRag extends RagLike {
  /** The queries (and options) `retrieve` was called with, in order. */
  queries(): ReadonlyArray<{
    query: string;
    options?: { topK?: number; namespace?: string; auth?: unknown };
  }>;
}

/** A {@link RagLike} double that returns a fixed context on every `retrieve`. */
export const memoryRag = (options: MemoryRagOptions = {}): MemoryRag => {
  const calls: Array<{
    query: string;
    options?: { topK?: number; namespace?: string; auth?: unknown };
  }> = [];

  return {
    retrieve: async (query, opts) => {
      calls.push(opts !== undefined ? { query, options: opts } : { query });

      return {
        context: options.context ?? '',
        chunks: options.chunks ?? [],
        sources: options.sources ?? [],
      };
    },
    queries: () => calls,
  };
};

/**
 * An {@link AgentGenerate} that returns a scripted result indexed by the loop's
 * turn number. Because the loop passes its 0-based turn index (not a message
 * count), the script stays correct across replays AND duplicate deliveries, where
 * the thread already carries the prior conversation.
 */
export const scriptedGenerate = (script: ReadonlyArray<AgentGenerateResult>): AgentGenerate => {
  return async ({ turn }) => {
    const entry = script[turn];

    if (entry === undefined) {
      throw new Error(`scriptedGenerate: no scripted result for turn ${String(turn)}`);
    }

    return entry;
  };
};

/** Build a tool-call turn result. */
export const toolCallTurn = (
  toolCalls: ReadonlyArray<AgentToolCall>,
  text = '',
): AgentGenerateResult => ({ text, toolCalls: [...toolCalls] });

/** Build a final-answer turn result (optionally carrying structured output). */
export const finalTurn = (text: string, output?: unknown): AgentGenerateResult =>
  output !== undefined ? { text, toolCalls: [], output } : { text, toolCalls: [] };

/** Options for {@link AgentHarness.runAgent}. */
export interface RunAgentOptions {
  params: AgentRunParams;
  env?: Record<string, unknown>;
  deliver?: Record<string, HarnessEvent>;
  run?: WorkflowRunFunction;
  /** Inject a scripted generate seam so no real model is needed (see {@link scriptedGenerate}). */
  generate?: AgentGenerate;
}

/** A replay harness scoped to compiled agents. */
export interface AgentHarness {
  /** The underlying `@velajs/workflow` replay harness (step-invocation counts, reset, …). */
  harness: ReplayHarness;
  /** Compile `agent` and run it to completion (or a non-deliverable suspension). */
  runAgent: (
    agent: AgentDefinition,
    exportName: string,
    options: RunAgentOptions,
  ) => Promise<HarnessResult<AgentRunResult>>;
}

/** Create an {@link AgentHarness} over a fresh, persistent durable log. */
export const createAgentHarness = (): AgentHarness => {
  const harness = createReplayHarness();

  let compiled:
    | {
        agent: AgentDefinition;
        exportName: string;
        generate: AgentGenerate | undefined;
        definition: WorkflowDefinition<AgentRunParams, AgentRunResult>;
      }
    | undefined;
  const runAgent = (
    agent: AgentDefinition,
    exportName: string,
    options: RunAgentOptions,
  ): Promise<HarnessResult<AgentRunResult>> => {
    if (
      compiled &&
      (compiled.agent !== agent ||
        compiled.exportName !== exportName ||
        compiled.generate !== options.generate)
    ) {
      throw new Error(
        'An agent harness belongs to one agent, export name, and generate seam. Create a fresh harness for another run.',
      );
    }
    compiled ??= {
      agent,
      exportName,
      generate: options.generate,
      definition: compileAgent(
        agent,
        exportName,
        options.generate !== undefined ? { generate: options.generate } : {},
      ),
    };
    const definition = compiled.definition;

    return harness.runToCompletion<AgentRunParams, AgentRunResult>(definition, {
      params: options.params,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.deliver !== undefined ? { deliver: options.deliver } : {}),
      ...(options.run !== undefined ? { run: options.run } : {}),
    });
  };

  return { harness, runAgent };
};

export type { HarnessEvent, HarnessResult, ReplayHarness } from '@velajs/workflow/harness';
