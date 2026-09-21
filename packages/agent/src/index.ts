/** Durable tool orchestration over Vela workflows. Completed step results are
 * replayed; atomic run claims handle duplicate delivery; scoped idempotency keys
 * let downstream services deduplicate retried effects. MCP and test adapters have
 * their own subpaths. The root runtime uses Web APIs only. */

// defineAgent + guard
export { defineAgent, isAgentDefinition } from './define-agent';

// compileAgent → @velajs/workflow WorkflowDefinition
export { compileAgent } from './compile-agent';
export type { CompileAgentOptions } from './compile-agent';

// Tools
export { defineAgentTool, functionTool, isAgentTool } from './tools';
export { agentAsTool } from './agent-as-tool';

// Naming helpers (pure string fns, for codegen parity)
export { agentBindingName, agentClassName, agentDefaultName } from './naming';

// Deterministic step-name + message-key grammar
export {
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
export type { MessageKeyKind } from './step-names';

// The AI-SDK generate seam
export { buildModelMessages, createAgentGenerate } from './generate';
export type { AgentGenerate, AgentGenerateOptions, AgentGenerateResult } from './generate';

// Inbound email (type-only mail contract)
export { firstEmailRun } from './email';
export type { InboundEmail } from './email';

// Errors
export { AgentError } from './errors';
export type { AgentErrorCode, AgentErrorOptions } from './errors';

// Approval constant
export { AGENT_APPROVAL_EVENT_TYPE } from './types';

// Core config + tool + event + run types
export type {
  AgentApprovalEvent,
  AgentApprovalVerificationContext,
  AgentAsToolOptions,
  AgentConfig,
  AgentDefinition,
  AgentEmailMapper,
  AgentEmailRun,
  AgentInstructionsContext,
  AgentMemoryConfig,
  AgentModelInput,
  AgentRunParams,
  AgentRunIdentity,
  AgentRunIdentityContext,
  AgentRunResult,
  AgentSubToolInput,
  AgentThreadEvent,
  AgentToolContext,
  AgentToolDefinition,
  AnyAgentTool,
  Env,
  FunctionToolConfig,
  RagLike,
  RouteToolConfig,
  WorkflowRunTarget,
} from './types';

// Thread store seam + message vocabulary
export type {
  AgentMessage,
  AgentMessageStatus,
  AgentRole,
  AgentThread,
  AgentThreadReader,
  AgentThreadScope,
  AgentThreadStatus,
  AgentThreadStore,
  AgentToolCall,
  AgentUsage,
  AppendMessageInput,
  AppendResult,
} from './store';

export { stepCountIs, hasToolCall } from './stop-conditions';
export type { AgentStopCondition, AgentCompletedTurn } from './stop-conditions';
