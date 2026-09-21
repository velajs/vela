/**
 * Tool constructors. `defineAgentTool` is the branding primitive; `functionTool`
 * is its ergonomic front door with two shapes: wrap a plain typed function, or
 * dispatch to an app route through the injected `run` seam. The loop passes the
 * model's args verbatim as `input`; the `inputSchema` mirrors the function's
 * validator, exactly as `@velajs/ai`'s tool convention does.
 */
import { asSchema } from 'ai';
import type { FlexibleSchema } from 'ai';
import { Validator } from '@cfworker/json-schema';
import { AgentError } from './errors';
import type {
  AgentToolContext,
  AgentToolDefinition,
  Env,
  FunctionToolConfig,
  RouteToolConfig,
  WorkflowRunTarget,
} from './types';

/** Both SDK generation and injected generation must cross the same validation boundary. */
export const validateToolInput = async <Input>(
  schema: FlexibleSchema<Input>,
  input: unknown,
): Promise<Input> => {
  const resolved = asSchema(schema);
  if (resolved.validate) {
    const result = await resolved.validate(input);
    if (result.success) return result.value;
  } else {
    // Both libraries describe draft-7 JSON Schema; they differ only in whether
    // optional fields explicitly include undefined under exactOptionalPropertyTypes.
    const validator = new Validator(
      (await resolved.jsonSchema) as ConstructorParameters<typeof Validator>[0],
    );
    if (validator.validate(input).valid) return input as Input;
  }
  throw new AgentError('AGENT_INVALID_TOOL_INPUT', 'Tool arguments failed inputSchema validation', {
    status: 400,
  });
};

/**
 * Validate and brand a tool definition. Throws `AGENT_INVALID_TOOL` on a missing
 * description / input schema / execute.
 */
export const defineAgentTool = <Input = unknown, Output = unknown>(
  config: FunctionToolConfig<Input, Output>,
): AgentToolDefinition<Input, Output> => {
  if (typeof config.description !== 'string' || config.description.length === 0) {
    throw new AgentError('AGENT_INVALID_TOOL', 'a tool needs a non-empty `description`');
  }

  if (config.inputSchema === undefined || config.inputSchema === null) {
    throw new AgentError('AGENT_INVALID_TOOL', 'a tool needs an `inputSchema` (zod | jsonSchema)');
  }

  if (typeof config.execute !== 'function') {
    throw new AgentError('AGENT_INVALID_TOOL', 'a tool needs an `execute` function');
  }

  const tool: AgentToolDefinition<Input, Output> = {
    description: config.description,
    inputSchema: config.inputSchema,
    execute: config.execute,
    isVelaAgentTool: true,
    ...(config.needsApproval !== undefined ? { needsApproval: config.needsApproval } : {}),
  };

  return tool;
};

/** True when `value` is a branded {@link AgentToolDefinition}. */
export const isAgentTool = (value: unknown): value is AgentToolDefinition => {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isVelaAgentTool?: unknown }).isVelaAgentTool === true
  );
};

/** Wrap a plain typed function as a tool. */
export function functionTool<Input = unknown, Output = unknown>(
  config: FunctionToolConfig<Input, Output>,
): AgentToolDefinition<Input, Output>;
/**
 * Dispatch to an app route as a tool: `execute` re-enters the app via the injected
 * `ctx.run(target, { body: input })`. Wrapping the `run` in the loop's durable
 * step is automatic — every tool call runs inside `tool:<name>:<id>`.
 */
export function functionTool<Input = unknown>(
  target: WorkflowRunTarget,
  config: RouteToolConfig<Input>,
): AgentToolDefinition<Input, unknown>;
export function functionTool<Input = unknown, Output = unknown>(
  configOrTarget: FunctionToolConfig<Input, Output> | WorkflowRunTarget,
  maybeConfig?: RouteToolConfig<Input>,
): AgentToolDefinition<Input, unknown> {
  if (maybeConfig !== undefined) {
    const target = configOrTarget as WorkflowRunTarget;
    const route = maybeConfig;

    return defineAgentTool<Input, unknown>({
      description: route.description,
      inputSchema: route.inputSchema,
      execute: (input: Input, ctx: AgentToolContext<Env, Input>): Promise<unknown> =>
        ctx.run(target, { body: input, headers: { 'Idempotency-Key': ctx.idempotencyKey } }),
      ...(route.needsApproval !== undefined ? { needsApproval: route.needsApproval } : {}),
    });
  }

  return defineAgentTool<Input, Output>(configOrTarget as FunctionToolConfig<Input, Output>);
}
