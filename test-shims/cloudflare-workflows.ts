// Node/vitest stand-in for the `cloudflare:workflows` runtime module, aliased in
// vitest.config.ts. Only `NonRetryableError` is consumed by the workflow adapter
// — the real class (thrown to abandon a workflow instance without retrying) is
// modelled here so the entrypoint's error translation can be exercised outside
// workerd. Workerd keys its retry decision off `error.name`, so the shim pins it
// to `"NonRetryableError"` just like the platform.

export class NonRetryableError extends Error {
  constructor(message: string, name = 'NonRetryableError') {
    super(message);
    this.name = name;
  }
}
