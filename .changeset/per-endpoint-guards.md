---
"@velajs/crud": minor
---

Add `guards` to `CrudConfig`: `Partial<Record<CrudEndpointName, GuardType[]>>`,
stamped per synthesized handler. Per-verb HTTP guards now work on both `@Crud`
controllers and headless `CrudModule.forFeature` resources — exactly like
hand-written routes with `@UseGuards`. Guards run after class-level `@UseGuards`
and global guards (AND); `@Override`'d endpoints receive their declared config
guards plus any of their own. Programmatic `resource.execute` dispatch is
intentionally unaffected. Additive — existing configs stay valid.
