# Changelog

## 0.2.0 (2026-04-28)

### Breaking changes

- **`CloudflareFactory` renamed to `createCloudflareApp`.** The factory object exposed exactly one method (`.create`) and was a thin wrapper around `VelaFactory`. Replaced with a plain async function:

  ```ts
  // before
  import { CloudflareFactory } from '@velajs/cloudflare';
  const app = await CloudflareFactory.create(AppModule);

  // after
  import { createCloudflareApp } from '@velajs/cloudflare';
  const app = await createCloudflareApp(AppModule);
  ```

### New

- `CloudflareApplication.scheduled()` now also dispatches `@Cron('expr')` jobs from `@velajs/vela`. Use either the cloudflare-specific `@Scheduled()` decorator or the framework's `@Cron()` decorator — both are matched against the incoming cron event.

### Compatibility

- Requires `@velajs/vela` ≥ 1.0.0 for the `@Cron` integration. The schedule split in vela 0.10 makes its `ScheduleModule` metadata-only, which lets edge platforms drive cron via their native triggers.

## 0.1.0 (2026-04-13)

Initial release.
