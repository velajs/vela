# WebSocket chat on a Durable Object

A single-file chat room: `src/index.ts` declares a `@WebSocketGateway` whose
rooms live in the `ChatRoom` Durable Object, serves a small browser page, and
exports the Worker. Every client in a room receives the others' messages, and
the sender gets an `ack` frame.

From the repository root, after `pnpm install --frozen-lockfile` and
`pnpm build`:

```sh
pnpm --filter vela-ws-chat dev        # vite dev: the Worker and ChatRoom in workerd
pnpm --filter vela-ws-chat test       # upgrade, greeting, chat broadcast and ack in workerd
pnpm --filter vela-ws-chat typecheck
pnpm --filter vela-ws-chat build      # the deployable Worker in dist/
```

Open the URL `vite dev` prints in two tabs and send messages from either one.

Vite 8 and `@cloudflare/vite-plugin` run `src/index.ts` directly; there is no
separate compile step. Oxc emits the legacy decorators, including the
`@WebSocketServer()` parameter decorator, that `oxc.config.ts` asks for; the
Vite and Vitest configs share that setting. `pnpm types` regenerates
`worker-configuration.d.ts` from `wrangler.jsonc`, which types `CHAT_ROOM` with
the `ChatRoom` class.

The gateway admits every upgrade as an anonymous visitor through a demo
`authenticateUpgrade`. A real application verifies a session cookie or a
short-lived socket ticket there instead. `pnpm run deploy` builds with Vite and
uploads `dist/` with Wrangler; do not pass `--config` to `wrangler deploy`,
which would bundle the source itself, without decorator metadata.
