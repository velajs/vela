# Durable agent approvals

Run from the monorepo root with Node 24+:

```sh
pnpm build
pnpm --filter @velajs/agent-approvals-example demo
```

The example needs no API key. It scripts a refund tool call, parks for approval,
loads the persisted challenge, resumes the same workflow log, and redelivers the
logical run through another instance. Assertions prove the refund happened once.

The in-memory store, scripted model, fixed identity, and approval set are testing
adapters. For deployment, supply an atomic persistent `AgentThreadStore`, derive
identity from authenticated trigger metadata, verify approvals through an
authenticated service, and pass the compiled handler a native durable workflow
context. See the [agent package](../../packages/agent/README.md).
