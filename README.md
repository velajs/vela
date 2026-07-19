# Vela Studio

Vela Studio — local admin panel + data time travel for Vela.js.

This repository is a pnpm workspace:

| Package | Description |
| --- | --- |
| [`@velajs/studio-protocol`](packages/protocol) | Wire contract: admin op catalog, envelopes, capabilities (types-only) |
| [`@velajs/studio`](packages/server) | Admin module: reserved `/_vela/admin` surface, `@AdminRpc` ops, time-travel port |
| [`@velajs/studio-ui`](packages/ui) | Admin panel UI (React) |
| [`@velajs/studio-host`](packages/host) | Loopback dev host serving the SPA and proxying the admin API |
| `@velajs/studio-fixtures` | Shared test fixtures (private) |

## Development

```bash
pnpm install
pnpm verify
```

## License

MIT
