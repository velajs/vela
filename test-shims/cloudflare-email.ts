// Node/vitest stand-in for the `cloudflare:email` runtime module, aliased in
// vitest.config.ts. Only `EmailMessage` is consumed by the outbound transport —
// the real class (`new (from, to, raw)`, single envelope recipient) is modelled
// here so the transport's fan-out and raw assembly can be exercised outside
// workerd. The stored fields mirror the platform's `EmailMessage` surface so a
// structural `SendEmail` double can read them in assertions.

export class EmailMessage {
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly raw: ReadableStream | string,
  ) {}
}
