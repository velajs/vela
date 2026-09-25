import { z } from 'zod';
import { parseAgentRunParams } from '../validation';

const key = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const scopeSchema = z.object({
  threadKey: key,
  agent: key,
  ownerId: key,
  tenantId: key,
});
export const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export const challengeSchema = z
  .object({
    instanceId: key,
    threadKey: key,
    runKey: key,
    toolCallId: key,
    turn: z.number().int().nonnegative(),
    toolName: key,
    inputDigest: digest,
    nonce: key,
    expiresAt: z.number().int().positive(),
    ownerId: key,
    tenantId: key,
  })
  .strict();
export const approvalSchema = challengeSchema
  .extend({
    decision: z.enum(['approve', 'reject']),
    approverId: key,
    note: z.string().max(1000).optional(),
  })
  .strict();
export const messageSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string(),
    toolCalls: z
      .array(z.object({ id: key, name: key, input: z.json() }).strict())
      .max(32)
      .optional(),
    toolCallId: key.optional(),
    toolName: key.optional(),
    status: z.enum(['awaiting_approval', 'approved', 'rejected']).optional(),
    approval: challengeSchema.optional(),
  })
  .strict();
export const threadSchema = scopeSchema
  .extend({
    status: z.enum(['running', 'idle', 'error', 'awaiting_input']),
    messageCount: z.number().int().nonnegative(),
    title: key.optional(),
    error: z.string().optional(),
    usage: usageSchema.optional(),
  })
  .strict();
export const resultSchema = z
  .object({
    stopped: z.enum(['final', 'maxTurns', 'stopCondition']),
    turns: z.number().int().nonnegative(),
    text: z.string().optional(),
    output: z.json().optional(),
    usage: usageSchema.optional(),
  })
  .strict();
export const ensureSchema = scopeSchema.extend({ runKey: key, title: key.optional() }).strict();
export const claimSchema = scopeSchema
  .extend({
    runKey: key,
    instanceId: key,
    inputDigest: digest,
  })
  .strict();
export const finishSchema = scopeSchema
  .extend({
    runKey: key,
    instanceId: key,
    result: resultSchema,
  })
  .strict();
export const appendSchema = scopeSchema
  .extend({
    ...messageSchema.omit({ seq: true }).shape,
    messageKey: z.string().min(1).max(4096),
  })
  .strict();
export const patchSchema = scopeSchema
  .extend({
    status: threadSchema.shape.status.optional(),
    error: z.string().optional(),
    usage: usageSchema.optional(),
  })
  .strict();

/** Standard Schema payload for runCloudflareWorkflow(compileAgent(...), ...).
 * Selectors still require resolveRunIdentity; schema validity is not authentication. */
export const agentRunParamsSchema = z
  .object({
    threadKey: key,
    input: z.string().max(256 * 1024),
    runKey: key.optional(),
    owner: key.optional(),
    tenantId: key.optional(),
    title: key.optional(),
  })
  .strict()
  .transform(parseAgentRunParams);
