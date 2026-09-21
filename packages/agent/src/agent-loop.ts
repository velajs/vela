/** Durable agent orchestration. Workflow steps checkpoint model/tool results;
 * the store owns scoped run claims and atomic message deduplication. Downstream
 * effects must honor scoped idempotency keys because uncheckpointed callbacks may
 * retry. Live events are best effort; persisted state is authoritative. */
import { boundedText, canonicalJson, digestJson } from './validation';
import { validateToolInput } from './tools';
import { AGENT_APPROVAL_EVENT_TYPE } from './types';
import { buildModelMessages } from './generate';
import {
  approvalChallengeStepName,
  approvalGateStepName,
  approvalVerificationStepName,
  approvalWaitName,
  llmTurnStepName,
  MEMORY_STEP_BASE,
  memoryStepName,
  messageKey,
  toolStepName,
} from './step-names';
import { agentDefaultName } from './naming';
import { AgentError } from './errors';
import type { AgentGenerate, AgentGenerateResult } from './generate';
import type { WorkflowLogger, WorkflowRunFunction, WorkflowStepLike } from '@velajs/workflow';
import type { AgentCompletedTurn, AgentStopCondition } from './stop-conditions';
import type {
  AgentApprovalEvent,
  AgentDefinition,
  AgentRunIdentity,
  AgentRunIdentityContext,
  AgentRunParams,
  AgentRunResult,
  AgentThreadEvent,
  AgentToolContext,
  AgentToolDefinition,
  AnyAgentTool,
  Env,
} from './types';
import type {
  AgentMessage,
  AgentThreadStatus,
  AgentThreadStore,
  AgentThreadScope,
  AgentToolCall,
  AgentUsage,
  AppendMessageInput,
  AppendResult,
} from './store';

/** Everything the loop needs, assembled by `compileAgent` from the workflow context. */
export interface RunAgentLoopDeps {
  agent: AgentDefinition;
  exportName: string;
  env: Env;
  params: AgentRunParams;
  instanceId: string;
  runKey: string;
  step: WorkflowStepLike;
  run: WorkflowRunFunction;
  log: WorkflowLogger;
  store: AgentThreadStore;
  generate: AgentGenerate;
  onThreadEvent?: (event: AgentThreadEvent) => void;
}

const DEFAULT_MAX_TURNS = 8;

/** Serialise a tool's return value to the stored string content. */
const normalizeToolOutput = (value: unknown): string =>
  typeof value === 'string' ? boundedText(value) : canonicalJson(value ?? null);

/** Accumulate token usage across turns (undefined fields contribute zero). */
const accrueUsage = (total: AgentUsage, delta: AgentUsage | undefined): AgentUsage => {
  if (delta === undefined) {
    return total;
  }

  return {
    inputTokens: (total.inputTokens ?? 0) + (delta.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (delta.outputTokens ?? 0),
    totalTokens: (total.totalTokens ?? 0) + (delta.totalTokens ?? 0),
  };
};

/** Turn an append input plus its allocated seq into a live-event message. */
const toEventMessage = (input: AppendMessageInput, seq: number): AgentMessage => {
  const message: AgentMessage = { seq, role: input.role, content: input.content };

  if (input.toolCalls !== undefined) {
    message.toolCalls = input.toolCalls;
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
  return message;
};

/**
 * Run one agent invocation to a terminal outcome. Called by `compileAgent`'s
 * workflow handler; returns the {@link AgentRunResult}.
 */
export const runAgentLoop = async (deps: RunAgentLoopDeps): Promise<AgentRunResult> => {
  const {
    agent,
    exportName,
    env,
    params,
    instanceId,
    runKey,
    step,
    run,
    log,
    store,
    generate,
    onThreadEvent,
  } = deps;
  if (
    !params ||
    !isCanonicalScopeId(params.threadKey) ||
    !isCanonicalScopeId(runKey) ||
    !isCanonicalScopeId(instanceId)
  ) {
    throw new AgentError(
      'AGENT_INVALID_DATA',
      'threadKey, runKey and instanceId must be canonical strings of at most 256 characters',
      { status: 400 },
    );
  }
  boundedText(params.input);
  if (params.title !== undefined) boundedText(params.title);
  const threadKey = params.threadKey;
  const agentName = agent.name ?? agentDefaultName(exportName);
  const identity = await resolveTrustedRunIdentity(agent, {
    env,
    instanceId,
    runKey,
    threadKey,
    ...(params.owner !== undefined ? { ownerSelector: params.owner } : {}),
    ...(params.tenantId !== undefined ? { tenantSelector: params.tenantId } : {}),
  });
  const scope: AgentThreadScope = {
    threadKey,
    agent: agentName,
    ownerId: identity.ownerId,
    tenantId: identity.tenantId,
  };

  /** Fire a live event, swallowing any sink error — emission is best-effort. */
  const emit = (event: AgentThreadEvent): void => {
    if (onThreadEvent === undefined) {
      return;
    }

    try {
      onThreadEvent(event);
    } catch {
      // A live sink must never break the durable run.
    }
  };

  /** Append a message and emit a `message` event ONLY when it is a genuine (non-deduped) write. */
  const append = async (
    draft: Omit<AppendMessageInput, keyof AgentThreadScope>,
  ): Promise<AppendResult> => {
    const input: AppendMessageInput = { ...scope, ...draft };
    const result = await store.appendMessage(input);

    if (!result.deduped) {
      emit({ type: 'message', threadKey, message: toEventMessage(input, result.seq) });
    }

    return result;
  };

  /** Patch thread status and emit a `status` event. */
  const patchStatus = async (
    status: AgentThreadStatus,
    error?: string,
    usage?: AgentUsage,
    key: string = status,
  ): Promise<void> => {
    await step.do(`status:${key}`, async () => {
      await store.patchThread({
        ...scope,
        status,
        ...(error !== undefined ? { error } : {}),
        ...(usage !== undefined ? { usage } : {}),
      });
      emit({ type: 'status', threadKey, status, ...(error !== undefined ? { error } : {}) });
    });
  };

  /** Assemble the tool `execute` context for one call. */
  const buildToolContext = (
    call: AgentToolCall,
    stepName: string,
  ): AgentToolContext<Env, unknown> => ({
    input: call.input,
    env,
    idempotencyKey: stepName,
    toolCallId: call.id,
    threadKey,
    runKey,
    ownerId: identity.ownerId,
    tenantId: identity.tenantId,
    thread: { list: () => store.listMessages(scope) },
    run,
    log,
    reportProgress: (_data: unknown): void => {
      // Ephemeral live-only progress hook. It runs only inside the memoized step
      // body, so it is never replayed. This batch ships no progress member on
      // AgentThreadEvent, so it is a documented no-op sink; a live transport can
      // widen it later.
    },
  });

  /** Resolve, gate, run, and persist one tool call. */
  const runToolCall = async (call: AgentToolCall, turn: number): Promise<void> => {
    const inputDigest = await digestJson(call.input);
    const resolved = resolveTool(agent, call.name);

    // Unknown tool → persist a recovery tool message so the next turn can react.
    if (resolved === undefined) {
      await append({
        messageKey: messageKey(runKey, 'tool', call.id),
        role: 'tool',
        content: `unknown tool: ${call.name}`,
        toolCallId: call.id,
        toolName: call.name,
      });

      return;
    }

    const stepName = toolStepName(call.name, call.id);
    const input = await validateToolInput(resolved.inputSchema, call.input);
    const idempotencyKey = `agent-${await digestJson([scope, runKey, call.name, call.id, inputDigest])}`;
    const toolCtx = buildToolContext({ ...call, input }, idempotencyKey);

    // The gate is a capability decision. Memoize it before parking so a replay
    // cannot turn a previously gated call into an ungated one.
    const gated = await step.do(approvalGateStepName(turn, call.name, call.id), () =>
      resolveNeedsApproval(resolved, input, toolCtx),
    );

    if (gated) {
      const challenge = await step.do(
        approvalChallengeStepName(turn, call.name, call.id),
        async () => ({
          nonce: crypto.randomUUID(),
          expiresAt: Date.now() + (agent.approvalTtlMs ?? 15 * 60 * 1000),
        }),
      );
      const expectedApproval: Omit<AgentApprovalEvent, 'decision' | 'approverId' | 'note'> = {
        instanceId,
        threadKey,
        runKey,
        toolCallId: call.id,
        turn,
        toolName: call.name,
        inputDigest,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        ownerId: identity.ownerId,
        tenantId: identity.tenantId,
      };
      const placeholder = await append({
        messageKey: messageKey(runKey, 'approval', call.id),
        role: 'tool',
        content: 'awaiting approval',
        toolCallId: call.id,
        toolName: call.name,
        status: 'awaiting_approval',
        approval: expectedApproval,
      });

      // Only announce the request on the genuine first park (not on a replay).
      await patchStatus('awaiting_input', undefined, undefined, `awaiting:${turn}:${call.id}`);
      if (!placeholder.deduped) {
        emit({
          type: 'approval-requested',
          threadKey,
          toolCallId: call.id,
          toolName: call.name,
          approval: expectedApproval,
        });
      }

      // Park until an approval event arrives; the wait memoizes on resume, so every
      // step before it stays memoized.
      const event = await step.waitForEvent(approvalWaitName(turn, call.name, call.id), {
        type: AGENT_APPROVAL_EVENT_TYPE,
        timeout: agent.approvalTtlMs ?? 15 * 60 * 1000,
      });
      // Authentication, authorization, and nonce consumption are one durable
      // step. Its verdict is replayed; a resumed workflow never consumes the
      // same approval twice or changes an already-recorded decision.
      const resolution = await step.do(
        approvalVerificationStepName(turn, call.name, call.id),
        async () => {
          const payload = parseApprovalEvent(event.payload);
          const verifier = agent.verifyApproval;
          if (
            payload === undefined ||
            !approvalBindingsMatch(payload, expectedApproval) ||
            payload.expiresAt <= Date.now() ||
            verifier === undefined ||
            !(await verifier(payload, { env, expected: expectedApproval }))
          ) {
            return { decision: 'reject' as const, note: 'invalid or unauthorized approval' };
          }
          return { decision: payload.decision, note: payload.note };
        },
      );
      const decision: AgentApprovalEvent['decision'] = resolution.decision;
      // Delivered at most once per memoized step execution; sinks remain best effort.
      await step.do(`approval-event:${turn}:${call.name}:${call.id}`, async () => {
        emit({ type: 'approval-resolved', threadKey, toolCallId: call.id, decision });
      });

      if (decision === 'reject') {
        const note = resolution.note;
        await append({
          messageKey: messageKey(runKey, 'tool', call.id),
          role: 'tool',
          content: note !== undefined ? `tool rejected: ${note}` : 'tool rejected',
          toolCallId: call.id,
          toolName: call.name,
          status: 'rejected',
        });
        await patchStatus('running', undefined, undefined, `resolved:${turn}:${call.id}`);

        return;
      }

      await patchStatus('running', undefined, undefined, `resolved:${turn}:${call.id}`);
    }

    // Approved (or ungated) → execute inside the durable step, then persist.
    const output = await step.do(stepName, async () =>
      normalizeToolOutput(await resolved.execute(input, toolCtx)),
    );
    await append({
      messageKey: messageKey(runKey, 'tool', call.id),
      role: 'tool',
      content: output,
      toolCallId: call.id,
      toolName: call.name,
      ...(gated ? { status: 'approved' as const } : {}),
    });
  };

  // 1. Get-or-create the thread header (idempotent by threadKey).
  const ensured = await store.ensureThread({
    ...scope,
    runKey,
    ...(params.title !== undefined ? { title: params.title } : {}),
  });
  if (
    ensured.thread.threadKey !== threadKey ||
    ensured.thread.agent !== agentName ||
    ensured.thread.ownerId !== identity.ownerId ||
    ensured.thread.tenantId !== identity.tenantId
  ) {
    throw new AgentError(
      'AGENT_THREAD_SCOPE_MISMATCH',
      'thread does not belong to the authenticated owner, tenant, and agent',
      { status: 403 },
    );
  }
  const previousResult = await store.claimRun({
    ...scope,
    runKey,
    instanceId,
    inputDigest: await digestJson({ input: params.input, title: params.title ?? null }),
  });
  if (previousResult !== undefined) return previousResult;
  const finish = async (result: AgentRunResult): Promise<AgentRunResult> => {
    await store.finishRun({ ...scope, runKey, instanceId, result });
    return result;
  };
  await patchStatus('running');

  // 2. Persist the user message (outside step.do, idempotent by key).
  await append({
    messageKey: messageKey(runKey, 'user'),
    role: 'user',
    content: params.input,
  });

  // 3. Inject memory in one durable step (the retrieved context only is memoized).
  let memoryContext = '';

  if (agent.memory !== undefined) {
    const memory = agent.memory;
    const rag = typeof memory.rag === 'function' ? memory.rag(env) : memory.rag;
    const stepName = memoryStepName(MEMORY_STEP_BASE, memory.key);

    memoryContext = await step.do(stepName, async () => {
      const retrievalScope = memory.resolveScope
        ? await memory.resolveScope({ ...identity, env, threadKey, runKey })
        : { namespace: memory.namespace ?? identity.tenantId, auth: memory.auth ?? identity };
      const retrieved = await rag.retrieve(params.input, {
        ...(memory.topK !== undefined ? { topK: memory.topK } : {}),
        ...retrievalScope,
      });

      return boundedText(retrieved.context);
    });
  }

  // 4. Resolve instructions once (a thunk must be pure / replay-stable).
  const instructions = resolveInstructions(agent, env, params.input, threadKey);

  // 5. The turn loop.
  const maxTurns = agent.maxTurns ?? DEFAULT_MAX_TURNS;
  let usage: AgentUsage = {};
  const completedTurns: AgentCompletedTurn[] = [];
  const seenToolCallIds = new Set<string>();

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const turnResult = await step.do(llmTurnStepName(turn), async () => {
      const rows = await store.listMessages(scope);
      const messages = buildModelMessages(instructions, memoryContext, rows);
      boundedText(JSON.stringify(messages));
      const result = await generate({
        turn,
        messages,
        ...(agent.activeTools !== undefined ? { activeTools: agent.activeTools } : {}),
        ...(agent.toolChoice !== undefined ? { toolChoice: agent.toolChoice } : {}),
      });
      canonicalJson(result);
      if (
        typeof result.text !== 'string' ||
        !Array.isArray(result.toolCalls) ||
        result.toolCalls.length > 32
      ) {
        throw new AgentError(
          'AGENT_INVALID_DATA',
          'A model turn needs text and at most 32 tool calls',
        );
      }
      return result;
    });

    usage = accrueUsage(usage, turnResult.usage);

    // No tool calls → this is the final answer.
    if (turnResult.toolCalls.length === 0) {
      await append({
        messageKey: messageKey(runKey, 'assistant', String(turn)),
        role: 'assistant',
        content: finalAssistantContent(turnResult),
      });
      await patchStatus('idle', undefined, usage);

      return finish(buildResult('final', turn + 1, turnResult, usage));
    }

    // Validate the complete turn before any tool side effect. IDs stay unique
    // across every prior turn, so a model cannot substitute a second call into
    // an already-approved/memoized capability slot.
    for (const call of turnResult.toolCalls) {
      if (
        !call ||
        !isNonEmptyString(call.id) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(call.id) ||
        !/^[A-Za-z][\w-]{0,63}$/.test(call.name) ||
        seenToolCallIds.has(call.id)
      ) {
        throw new AgentError(
          'AGENT_DUPLICATE_TOOL_CALL_ID',
          `tool call ids must be non-empty, bounded, and unique for the entire run: "${call.id}"`,
          { status: 400 },
        );
      }
      seenToolCallIds.add(call.id);
    }

    // Validate every argument before executing any side effect in this turn.
    for (const call of turnResult.toolCalls) {
      canonicalJson(call.input);
      const tool = resolveTool(agent, call.name);
      if (tool) await validateToolInput(tool.inputSchema, call.input);
    }

    // Persist the assistant tool-call intent.
    await append({
      messageKey: messageKey(runKey, 'assistant', String(turn)),
      role: 'assistant',
      content: turnResult.text,
      toolCalls: turnResult.toolCalls,
    });

    // Run each tool call as a sequential durable step.
    for (const call of turnResult.toolCalls) {
      await runToolCall(call, turn);
    }

    completedTurns.push({ text: turnResult.text, toolCalls: turnResult.toolCalls });

    // Evaluate stop conditions (composed with maxTurns).
    const stopWhen = agent.stopWhen;
    if (
      stopWhen !== undefined &&
      (await step.do(`stop:turn:${turn}`, () => evaluateStopWhen(stopWhen, completedTurns)))
    ) {
      await patchStatus('idle', undefined, usage);

      return finish(buildResult('stopCondition', turn + 1, turnResult, usage));
    }
  }

  // Loop exhaustion.
  await patchStatus('error', 'maxTurns exceeded', usage);

  return finish({ stopped: 'maxTurns', turns: maxTurns, usage });
};

const APPROVAL_KEYS = new Set([
  'decision',
  'instanceId',
  'threadKey',
  'runKey',
  'toolCallId',
  'turn',
  'toolName',
  'inputDigest',
  'nonce',
  'expiresAt',
  'approverId',
  'ownerId',
  'tenantId',
  'note',
]);

const parseApprovalEvent = (value: unknown): AgentApprovalEvent | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((key) => !APPROVAL_KEYS.has(key))) return undefined;
  const candidate = value as Partial<AgentApprovalEvent>;
  if (
    (candidate.decision !== 'approve' && candidate.decision !== 'reject') ||
    !isNonEmptyString(candidate.instanceId) ||
    !isNonEmptyString(candidate.threadKey) ||
    !isNonEmptyString(candidate.runKey) ||
    !isNonEmptyString(candidate.toolCallId) ||
    !Number.isSafeInteger(candidate.turn) ||
    (candidate.turn ?? -1) < 0 ||
    !isNonEmptyString(candidate.toolName) ||
    !/^[a-f0-9]{64}$/.test(candidate.inputDigest ?? '') ||
    !isNonEmptyString(candidate.nonce) ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    !isNonEmptyString(candidate.approverId) ||
    !isCanonicalScopeId(candidate.ownerId) ||
    !isCanonicalScopeId(candidate.tenantId) ||
    (candidate.note !== undefined &&
      (typeof candidate.note !== 'string' || candidate.note.length > 1000))
  ) {
    return undefined;
  }
  return candidate as AgentApprovalEvent;
};

const approvalBindingsMatch = (
  event: AgentApprovalEvent,
  expected: Omit<AgentApprovalEvent, 'decision' | 'approverId' | 'note'>,
): boolean =>
  event.instanceId === expected.instanceId &&
  event.threadKey === expected.threadKey &&
  event.runKey === expected.runKey &&
  event.toolCallId === expected.toolCallId &&
  event.turn === expected.turn &&
  event.toolName === expected.toolName &&
  event.inputDigest === expected.inputDigest &&
  event.nonce === expected.nonce &&
  event.expiresAt === expected.expiresAt &&
  event.ownerId === expected.ownerId &&
  event.tenantId === expected.tenantId;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isCanonicalScopeId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim();

const resolveTrustedRunIdentity = async (
  agent: AgentDefinition,
  context: AgentRunIdentityContext,
): Promise<AgentRunIdentity> => {
  const resolver = agent.resolveRunIdentity;
  if (typeof resolver !== 'function') {
    throw new AgentError(
      'AGENT_UNTRUSTED_RUN_IDENTITY',
      'runtime execution requires resolveRunIdentity',
      { status: 403 },
    );
  }

  const identity = await resolver(context);
  if (
    identity === null ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    Object.getPrototypeOf(identity) !== Object.prototype ||
    Object.keys(identity).length !== 2 ||
    !Object.hasOwn(identity, 'ownerId') ||
    !Object.hasOwn(identity, 'tenantId') ||
    !isCanonicalScopeId(identity.ownerId) ||
    !isCanonicalScopeId(identity.tenantId)
  ) {
    throw new AgentError(
      'AGENT_UNTRUSTED_RUN_IDENTITY',
      'resolveRunIdentity returned an invalid identity',
      { status: 403 },
    );
  }
  return { ownerId: identity.ownerId, tenantId: identity.tenantId };
};

/** Resolve the `instructions` config to a concrete system prompt. */
const resolveInstructions = (
  agent: AgentDefinition,
  env: Env,
  input: string,
  threadKey: string,
): string => {
  const instructions = agent.instructions;

  if (instructions === undefined) {
    return '';
  }

  return typeof instructions === 'function'
    ? instructions({ env, input, threadKey })
    : instructions;
};

/** Look up a tool by name, honouring `activeTools`. */
const resolveTool = (agent: AgentDefinition, name: string): AnyAgentTool | undefined => {
  const tool = Object.hasOwn(agent.tools ?? {}, name) ? agent.tools?.[name] : undefined;

  if (tool === undefined) {
    return undefined;
  }

  if (agent.activeTools !== undefined && !agent.activeTools.includes(name)) {
    return undefined;
  }

  return tool;
};

/** Evaluate `needsApproval` (boolean or predicate). */
const resolveNeedsApproval = async (
  tool: AgentToolDefinition,
  input: unknown,
  ctx: AgentToolContext<Env, unknown>,
): Promise<boolean> => {
  const needsApproval = tool.needsApproval;

  if (needsApproval === undefined) {
    return false;
  }

  if (typeof needsApproval === 'boolean') {
    return needsApproval;
  }

  return needsApproval(input, ctx);
};

/** Evaluate conditions against the completed durable tool turns. */
const evaluateStopWhen = async (
  stopWhen: AgentStopCondition | ReadonlyArray<AgentStopCondition>,
  completedTurns: ReadonlyArray<AgentCompletedTurn>,
): Promise<boolean> => {
  const conditions = Array.isArray(stopWhen) ? stopWhen : [stopWhen];
  const steps = completedTurns;

  for (const condition of conditions) {
    if (await condition({ steps })) {
      return true;
    }
  }

  return false;
};

/** The stored content of a final assistant message: text, else JSON output, else empty. */
const finalAssistantContent = (turnResult: AgentGenerateResult): string => {
  if (turnResult.text.length > 0) {
    return turnResult.text;
  }

  return turnResult.output !== undefined ? JSON.stringify(turnResult.output) : '';
};

/** Build the terminal {@link AgentRunResult} for a `final` / `stopCondition` stop. */
const buildResult = (
  stopped: 'final' | 'stopCondition',
  turns: number,
  turnResult: AgentGenerateResult,
  usage: AgentUsage,
): AgentRunResult => {
  const result: AgentRunResult = { stopped, turns, text: turnResult.text, usage };

  if (turnResult.output !== undefined) {
    result.output = turnResult.output;
  }

  return result;
};
