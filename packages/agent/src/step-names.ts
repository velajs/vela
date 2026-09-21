/**
 * The two deterministic name grammars the loop derives everything from. NEITHER
 * uses `Date.now()` or `Math.random()`: every index comes from the turn loop
 * counter or a provider-issued tool-call id (itself replayed from a memoized LLM
 * step). Exported so the CF entrypoint and any resume endpoint reproduce the exact
 * names the loop used.
 *
 * DURABLE STEP NAMES (memoized by `step.do` / `waitForEvent`, per workflow
 * instance):
 *  - memory inject: `memory:retrieve` | `memory:retrieve:<key>`
 *  - LLM turn:      `llm:turn:<T>`   (0-based loop index)
 *  - tool call:     `tool:<name>:<toolCallId>`
 *  - approval wait: `approval:<turn>:<toolName>:<toolCallId>`
 *
 * MESSAGE KEYS (the store's dedup namespace; root `runKey` is replay-stable AND
 * stable across duplicate deliveries of the same logical run):
 *  - user turn:            `<runKey>:user`
 *  - assistant turn:       `<runKey>:assistant:<T>`
 *  - tool result:          `<runKey>:tool:<toolCallId>`
 *  - approval placeholder: `<runKey>:approval:<toolCallId>`
 */

/** The base durable step name for memory retrieval. */
export const MEMORY_STEP_BASE = 'memory:retrieve';

/** `memory:retrieve` for the default source, `memory:retrieve:<key>` for a keyed one. */
export const memoryStepName = (base: string, key: string | undefined): string =>
  key === undefined || key === 'default' ? base : `${base}:${key}`;

/** `llm:turn:<t>` — `t` is the 0-based loop index. */
export const llmTurnStepName = (turn: number): string => `llm:turn:${String(turn)}`;

/** `tool:<name>:<id>` — instance-local durable step label; external keys are scoped hashes. */
export const toolStepName = (name: string, id: string): string => `tool:${name}:${id}`;

/** Bound approval `waitForEvent` name. */
export const approvalWaitName = (turn: number, name: string, id: string): string =>
  `approval:${String(turn)}:${name}:${id}`;

/** Bound challenge step; memoizes the random nonce and request expiry. */
export const approvalChallengeStepName = (turn: number, name: string, id: string): string =>
  `approval-challenge:${String(turn)}:${name}:${id}`;

/** Bound gate step; memoizes the capability/approval requirement. */
export const approvalGateStepName = (turn: number, name: string, id: string): string =>
  `approval-gate:${String(turn)}:${name}:${id}`;

/** Bound verification step; memoizes the atomic approval-consumption verdict. */
export const approvalVerificationStepName = (turn: number, name: string, id: string): string =>
  `approval-verify:${String(turn)}:${name}:${id}`;

/** The kinds of message-key namespaces the store dedups on. */
export type MessageKeyKind = 'user' | 'assistant' | 'tool' | 'approval';

/** `<runKey>:<kind>` or `<runKey>:<kind>:<suffix>`. */
export const messageKey = (runKey: string, kind: MessageKeyKind, suffix?: string): string =>
  suffix === undefined
    ? `${encodeURIComponent(runKey)}:${kind}`
    : `${encodeURIComponent(runKey)}:${kind}:${encodeURIComponent(suffix)}`;
