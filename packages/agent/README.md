# @velajs/agent

Durable model/tool orchestration over [`@velajs/workflow`](../workflow/README.md).
Use it when an AI task must survive replay, persist a conversation, or pause for
human approval. Use the AI SDK directly for a single request or streaming chat;
use workflows directly for predetermined business processes. Agent adds the
model-directed tool loop and its storage/approval contracts. It does not add an
agent server, scheduler, model provider, or automatic Worker discovery. An optional
Cloudflare subpath supplies durable thread persistence.

## Install and supported imports

```sh
pnpm add @velajs/agent ai zod
```

The 1.x API uses AI SDK 7.0.26+ and Zod 4.4.3+. Zod is optional when using SDK
`jsonSchema` instead. Runtime dependencies are the portable workflow/error
packages and a Web API JSON Schema validator. `@velajs/ai` and `@velajs/mail` are
optional integrations; mail is a type-only boundary. Install mail when consuming
its email types. MCP's SDK is needed only for URL-based connections.

| Import | Supported API |
| --- | --- |
| `@velajs/agent` | `defineAgent`, `compileAgent`, `defineAgentTool`, `functionTool`, `agentAsTool`, guards, `stepCountIs`, `hasToolCall`, model-message/generation seams, naming helpers, `firstEmailRun`, types and errors |
| `@velajs/agent/mcp` | `mcpTools`, `closeMcpTools`, structural MCP client/options types |
| `@velajs/agent/cloudflare` | `AgentThreadDurableObject`, `durableAgentThreadStore`, `agentRunParamsSchema`, `DurableAgentThreadStore` (Workers and Zod 4 required) |
| `@velajs/agent/testing` | `memoryThreadStore`, `memoryRag`, `scriptedGenerate`, `toolCallTurn`, `finalTurn`, `createAgentHarness`, workflow harness types |

Root imports use Web APIs and do not load Vela core, Cloudflare virtual modules,
mail, the Vela AI package, or the MCP SDK at runtime.

## Runnable example

[The approval example](../../apps/agent-approvals/README.md) runs without an API
key, verifies a parked approval, resumes the tool, and checks duplicate delivery:

```sh
pnpm build
pnpm --filter @velajs/agent-approvals-example demo
```

A production declaration supplies a model, persistent store, and authenticated
identity resolver. This abbreviated example assumes those application services
have already been constructed:

```ts
import { compileAgent, defineAgent, functionTool } from '@velajs/agent';
import { z } from 'zod';

const support = defineAgent({
  model, // AI SDK LanguageModel, model id, or (env) => model
  store, // AgentThreadStore or (env) => store
  resolveRunIdentity, // authenticated trigger -> { ownerId, tenantId }
  verifyApproval, // authenticate, authorize and idempotently record a verdict
  tools: {
    refund: functionTool({
      description: 'Refund the requested order.',
      inputSchema: z.object({ orderId: z.string() }),
      needsApproval: true,
      execute: ({ orderId }, ctx) => payments.refund({
        orderId, tenantId: ctx.tenantId, idempotencyKey: ctx.idempotencyKey,
      }),
    }),
  },
});
const workflow = compileAgent(support, 'support');
```

`compileAgent` returns `WorkflowDefinition<AgentRunParams, AgentRunResult>`.
Its handler consumes a workflow context with `env`, `event`, `step`, `run`, and
`log`. To deploy, wire that definition into an application-owned native
`WorkflowEntrypoint`, pass the native durable step API, and inject an authenticated
application dispatcher. There is currently no `createWorkflowEntrypoint` helper
or automatic agent discovery in `@velajs/cloudflare`. The naming helpers only
produce names; applications register Wrangler bindings themselves.

## Replay, duplicate delivery, and side effects

Each LLM turn executes in `llm:turn:<turn>`, and each tool executes in
`tool:<name>:<callId>`. Completed workflow steps reuse their recorded output.
A failed or interrupted callback can run again before its result is checkpointed.

Each logical run supplies a stable `runKey` (default: workflow instance ID).
An atomic store claim binds that key to its input and one workflow instance.
A duplicate completed run returns the stored result without another model/tool
call. A competing instance or concurrent different run on the same thread fails
with `AGENT_RUN_CONFLICT`; changed input cannot reuse an old key. Route incoming
duplicate triggers to the original workflow instance whenever possible.

Tools receive an `agent-<sha256>` idempotency key binding authenticated owner,
tenant, agent, thread, logical run, tool name, call ID, and raw input digest.
Pass it to downstream services that atomically deduplicate effects. Workflow
memoization cannot make a remote payment atomic with its checkpoint. Preserve
claims for the entire delivery/replay retention period; replaying after deleting
claims or resetting native workflow history is outside this guarantee.

Thread message keys encode their components and deduplicate atomically on
`(threadKey, messageKey)`. `messageKey` and the durable-name helpers are exported.
Tool names are identifiers of at most 64 characters. Tool-call IDs accept ASCII
letters, digits, `_` and `-`, up to 128 characters, and must be unique per run.

## Persistent thread-store contract

`AgentThreadStore` is a required application adapter. Every operation checks
`{ threadKey, agent, ownerId, tenantId }` in the same serialized transaction as
its read/write. A thread key is globally unique in a store and cannot change
owners, tenants, or agents.

- `ensureThread`: atomic get-or-create; first writer establishes immutable scope.
- `claimRun`: compare input digest and instance; return a completed result, allow
  same-instance replay, or reject a competing active run. Claims are persistent.
- `appendMessage`: insert once per message key; allocate a gap-free `seq` from a
  per-thread counter in the same transaction. Return original seq on duplicates.
- `listMessages`: return authorized rows in ascending sequence, without shared
  mutable references. Approval placeholders include their persisted challenge.
- `patchThread`: update status/error/usage in the authenticated scope.
- `finishRun`: atomically store the result and release that run's active claim.

`memoryThreadStore` is an isolated reference implementation for tests, not a
production persistence adapter. Unexpected failures deliberately retain the claim
so the owning instance can resume. To abandon a run, an application must first
verify that the native instance is terminal/terminated and then recover its
persistent claim transactionally. Never expire a claim while its instance could
still execute effects. Serialize same-instance execution through the native
workflow runtime, as the harness does.

`resolveRunIdentity` must return canonical, nonempty `ownerId` and `tenantId`
values from authenticated runtime metadata. Trigger `owner`/`tenantId` values are
selectors to verify, never proof of identity. Store implementations must enforce
scope for every operation, including reads and completion.

## SQLite Durable Object driver

`@velajs/agent/cloudflare` implements the existing `AgentThreadStore` contract.
Export `class Threads extends AgentThreadDurableObject {}` and register it with
`new_sqlite_classes` in a Wrangler migration. Construct
`durableAgentThreadStore(env.THREADS)` per environment; never cache a namespace
from another deployment. Each thread key routes to one object, independent of
untrusted owner/tenant selectors. The first writer establishes immutable scope.
Each read/write compares that scope inside `storage.transactionSync`, along with
claim changes, message sequence allocation and deduplication. Private helpers use
JavaScript private names and are not RPC methods.

The binding is a trusted server capability, not an authentication service.
Resolve identity before invoking it. An attacker who can invoke arbitrary RPC
with the real owner/tenant scope already has the binding's authority. Do not
publish generic RPC/HTTP passthrough routes. Schema checks at RPC ingress and
stored-row reads reject invalid data; each written JSON value is bounded to
256 KiB. `listMessages` returns the entire history as required by the portable
contract, so applications must bound thread growth to fit Workers RPC/memory
limits and their model context budget.

The native extension adds two methods:

- `recordApproval(scope, event)`: call from an authenticated approval endpoint
  after deriving the approver from verified identity. It atomically checks the
  persisted challenge, active run and expiry, and records an immutable decision.
  Identical delivery is idempotent; a changed verdict or binding fails.
- `verifyApproval(scope, event)`: compare the workflow-delivered event with that
  durable decision. Use it in `defineAgent({ verifyApproval })`. The same stored
  verdict survives a crash before the native verification checkpoint; it is not
  an in-memory nonce set. The agent loop also validates bindings and expiry.

Record the decision before `instance.sendEvent`. If delivery fails, resend the
same decision. It is acceptable for a recorded approval never to be delivered;
no tool runs until the workflow has received and verified it. This does not
implement a general approval service or an outbox.

Compile with `compileAgent`, then call `runCloudflareWorkflow` from the native or
Vela host, using `schema: agentRunParamsSchema`. That schema validates at native
ingress; `resolveRunIdentity` still verifies trigger selectors. The
[deployment example](../../apps/agent-approvals/README.md#native-worker) exercises
the DI host and authenticated dispatch without model credentials.

Claims, messages, decisions and completed results are retained indefinitely.
There is deliberately no TTL, automatic failed-run takeover, garbage collection,
or public deletion method. An unexpected error keeps the owning claim. Recovery
requires proving the native instance cannot execute again before transactionally
changing its claim; deleting/restarting native history alone is insufficient.
Remote effects still require idempotency. This driver provides durable local
transactions, not exactly-once remote effects or a replacement Agents SDK.

Cloudflare documents the underlying
[SQLite transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync).
Native tests exercise concurrent claims and appends, scope rejection on every
operation, rollback, restart recovery, approval wait/resume and duplicate delivery.

### Native event-name migration

The approval event type is now `agent-approval`. The old `agent:approval` contains
an unsupported native event-name character. Update senders and listeners together;
always import `AGENT_APPROVAL_EVENT_TYPE`. Drain existing portable/harness waits
or run the old definition separately before switching an in-flight deployment.

## Approvals

A gated tool records the gate, nonce, expiry, and approval placeholder before
waiting for `AGENT_APPROVAL_EVENT_TYPE` (`agent-approval`). The default TTL is
15 minutes. Load the challenge from the stored placeholder when a live event
was missed. The application's authenticated resume endpoint sends that challenge
plus `decision: 'approve' | 'reject'`, `approverId`, and an optional note.

The runtime checks exact instance/thread/run/tool/turn/input/owner/tenant/nonce/
expiry bindings and calls `verifyApproval`. Missing verification, invalid payloads,
and expired or unauthorized approvals reject the tool. Verification is memoized,
but its callback can retry before checkpointing: atomically store the verdict
under the fully bound nonce and return that same verdict for its legitimate
retry. Reject reuse for any different binding. An untrusted caller must not be
able to select an approver or deliver workflow events directly.

The first delivered event resolves the wait; invalid events fail closed, so an
unauthenticated event endpoint could deny service. Native wait timeouts follow
the workflow runtime's error behavior. They do not silently approve a tool.

Live events are best-effort notifications, not a durable event bus. Status and
approval resolution emit inside memoized steps, and message/approval-request
notifications emit on newly persisted rows. A crash between persistence and
emission can lose a notification; retries before a checkpoint can repeat one.
Read the store to recover state, and authorize subscriptions separately.

## Tools, models, and stopping

`functionTool({ description, inputSchema, execute, needsApproval? })` preserves
input/output inference. All arguments in a model turn are validated before any
tool effect, including arguments from an injected `AgentGenerate`.
`functionTool(target, options)` calls the injected dispatcher with the validated
body and `Idempotency-Key` header; its result is `unknown`. Parse route results in
a function tool when a domain type is needed. Internal dispatch must retain
application authorization; the header is a deduplication hint, not credentials.

`agentAsTool({ name, description, maxPolls?, pollIntervalMs?, wait? })` starts a
child through `env[agentBindingName(name)]`. IDs hash the parent tenant, owner,
thread, run and call to avoid cross-conversation collisions. The child must still
resolve its own trusted identity; parent-supplied owner/tenant values are selectors.
This adapter is bounded synchronous composition (default 60 polls × 500 ms,
maximum 120 polls/60 seconds); `wait: false` is rejected. Longer child jobs should
be composed explicitly with durable workflow waits. A timed-out parent does not
terminate its child. The create/get retry path assumes the application's binding
namespace and retained instances are trusted.

`maxTurns` defaults to 8 and is bounded to 128. `stopWhen` receives actual
`AgentCompletedTurn` objects. Import `stepCountIs` and `hasToolCall` from this
package; arbitrary AI SDK `StopCondition` callbacks require richer SDK step data
and are no longer accepted. `activeTools`, `toolChoice`, temperature,
`maxOutputTokens`, and schema-based final `output` remain supported.

Model turns allow at most 32 tool calls. Tool/model JSON data, retrieved context,
and the complete model prompt are capped at 256 KiB, with finite JSON values,
depth 32 and 10,000 nodes for serialized JSON. Oversized/unserializable results
fail before checkpointing. Manage conversation retention in your store; the
runtime never silently truncates history. Instructions thunks and schemas must
remain replay-stable for an in-flight definition.

## Optional RAG, MCP, and mail

`memory: { rag, mode: 'inject', topK?, namespace?, auth?, key?, resolveScope? }`
accepts a structural `RagLike`, compatible with `@velajs/ai/rag`'s `retrieve`.
Retrieval executes in one durable step. By default it passes the resolved tenant
as namespace and the authenticated agent identity as `auth`. `resolveScope`
derives application-specific per-run retrieval credentials from that identity.
The RAG adapter must authorize selectors and enforce partition isolation.
Retrieved context is delimited untrusted user data, never a system instruction.

`mcpTools` requires an explicit `only` allowlist. Every tool requires approval
unless listed in application-verified `readOnlyTools`. Inject a `McpClientLike`
that honors cancellation and byte limits, or supply a HTTPS `url`, exact
`allowedHosts`, and an egress-policy `fetch` that rejects private DNS targets.
URL mode dynamically loads the optional MCP SDK. Redirects, stdio, private
literal hosts, excessive tool listings, and oversized responses are rejected.
Operations are bounded to 30 seconds, with at most 1 MiB of MCP result data;
the loop's 256 KiB stored-result limit still applies. Idempotency keys travel in
`_meta['velajs.dev/idempotency-key']`; the remote server must honor them.
Call `closeMcpTools(tools)` when the map is no longer used. Timeout cancellation
also closes the client. Do not share a client across tenants with different
credentials or egress policies.

`onEmail` and `firstEmailRun` map the real mail package's `InboundEmail` to validated
run parameters or drop the email. They do not dispatch anything. Gate on trusted
adapter authentication verdicts, not spoofable `from` or raw Authentication-Results
headers. Map authenticated senders to an authorized owner/tenant, then revalidate
through `resolveRunIdentity` when the workflow runs.

## Migrating the standalone source

The standalone 0.1.0 manifest was unpublished (npm registry returned 404 on
2026-09-21); this monorepo package starts at 1.0.0. Existing public root, `/mcp`,
and `/testing` exports are retained, with intentional corrections:

- Implement `claimRun`/`finishRun` and persist approval challenges in your store.
- Use scoped hashed tool keys; keys no longer equal durable step labels.
- Use agent stop-condition helpers and parse route-dispatch results.
- Move schemas to Zod 4; AI/workflow/mail integrations target their migrated 1.x APIs.
- Update child IDs, encoded message-key components, and payload budgets.
- Reuse one definition/environment/generation seam per test harness. Create a
  fresh harness for a different workflow instance; replay preserves memoized work.

The original MIT license and pre-monorepo changelog are retained. Source was
migrated from `velajs/agent` at `daddea037ed5b34657fc9a3a1a5adb3dc426c6a5`.
Releases and Changesets are owned by the monorepo root; see
[RELEASING.md](../../RELEASING.md).
