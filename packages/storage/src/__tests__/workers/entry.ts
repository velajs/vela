// Minimal worker entry that backs `pnpm test:workers` (see wrangler.toml).
// The R2 binding driver is exercised directly from the test using the
// `cloudflare:test` `env`; this entry just satisfies wrangler's `main`.
export default {
  async fetch(): Promise<Response> {
    return new Response('ok');
  },
};
