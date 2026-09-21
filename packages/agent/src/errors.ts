/**
 * The agent error taxonomy. Every failure is a `@velajs/errors` `VelaError` with
 * an `AGENT_*` code and a `@velajs/agent:` message prefix, so it rides the wire
 * codec / DO-RPC prop-copy path unchanged and is recognised by `isVelaError`.
 */
import { VelaError } from '@velajs/errors';

export type AgentErrorCode =
  | 'AGENT_INVALID_DATA'
  | 'AGENT_RUN_CONFLICT'
  | 'AGENT_MODEL_REQUIRED'
  | 'AGENT_INVALID_MAX_TURNS'
  | 'AGENT_INVALID_APPROVAL_TTL'
  | 'AGENT_INVALID_TOOL_NAME'
  | 'AGENT_INVALID_MEMORY_MODE'
  | 'AGENT_INVALID_TOOL'
  | 'AGENT_INVALID_STORE'
  | 'AGENT_RUN_IDENTITY_REQUIRED'
  | 'AGENT_THREAD_SCOPE_MISMATCH'
  | 'AGENT_UNTRUSTED_RUN_IDENTITY'
  | 'AGENT_DUPLICATE_TOOL_CALL_ID'
  | 'AGENT_INVALID_TOOL_INPUT'
  | 'AGENT_MCP_UNSUPPORTED_TRANSPORT'
  | 'AGENT_MCP_MISSING_CLIENT'
  | 'AGENT_MCP_INVALID_CONFIGURATION'
  | 'AGENT_MCP_TIMEOUT'
  | 'AGENT_MCP_RESULT_TOO_LARGE'
  | 'AGENT_SUBAGENT_BINDING_MISSING'
  | 'AGENT_SUBAGENT_FAILED';

export interface AgentErrorOptions {
  status?: number;
  cause?: unknown;
  data?: unknown;
}

/**
 * A `VelaError` specialised for the agent package. Prefixes `message` with
 * `@velajs/agent:` and defaults the HTTP status to 500 (a declaration/validation
 * fault is server-side).
 */
export class AgentError extends VelaError {
  constructor(code: AgentErrorCode, message: string, options: AgentErrorOptions = {}) {
    super(code, {
      message: `@velajs/agent: ${message}`,
      status: options.status ?? 500,
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
      ...(options.data !== undefined ? { data: options.data } : {}),
    });
    this.name = 'AgentError';
  }
}
