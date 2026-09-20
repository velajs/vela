# Vela Studio

Vela Studio — local admin panel + data time travel for Vela.js.

Studio is composed of these workspace packages:

| Package | Description |
| --- | --- |
| [`@velajs/studio-protocol`](../../packages/studio-protocol) | Wire contract: admin op catalog, envelopes, capabilities (types-only) |
| [`@velajs/studio`](../../packages/studio) | Admin module: reserved `/_vela/admin` surface, `@AdminRpc` ops, time-travel port |
| [`@velajs/studio-ui`](../../packages/studio-ui) | Admin panel UI (React) |
| [`@velajs/studio-host`](../../packages/studio-host) | Loopback dev host serving the SPA and proxying the admin API |
| `@velajs/studio-fixtures` | Shared test fixtures (private) |

## Development

```bash
pnpm install
pnpm verify
```

## License

MIT
