---
'@velajs/vela': minor
'@velajs/cloudflare': minor
---

CORS is configured as in Nest. `app.enableCors(options?)` on `VelaApplication` and the `cors` create option (`VelaFactory.create(AppModule, { cors: true | CorsOptions })`) serve Hono's `cors` middleware ahead of body limits, routing and guards, so preflights are answered before any guard runs and refusals stay readable cross-origin. `enableCors` takes effect on the next request with no rebuild; a later call replaces the options. A credentialed `'*'` origin and a negative `maxAge` are rejected. `CorsOptions` is exported from `@velajs/vela`. On Workers, `createCloudflareWorker(AppModule, { cors })` and `createCloudflareApp(AppModule, { env, cors })` take the same option, and `CloudflareApplication.enableCors()` works inside `configure(app, env)`. Every application now carries Hono's `cors` middleware and one pass-through middleware when CORS is off: with this release's other changes, the minimal Worker is 122,031 bytes raw and 40,979 gzipped through `VelaFactory.create()`, and 146,552 raw and 49,432 gzipped through `createCloudflareWorker()`, within the unchanged budgets.

**Behavior change:** `CorsModule` and `CORS_OPTIONS` are removed from `@velajs/vela/security`. Replace `imports: [CorsModule.forRoot(options)]` with `app.enableCors(options)` or the `cors` create option; the options keep their shape (`origin`, `allowMethods`, `allowHeaders`, `exposeHeaders`, `credentials`, `maxAge`). `SecurityModule`'s exact-origin `cors` option is unchanged.
