---
'@velajs/crud': patch
'@velajs/studio': patch
---

Follow the uniform module contract: `CrudModule` uses the default instance key and its tokens are plain `InjectionToken`s; `StudioLoggingModule`, `StudioTimeTravelModule` and `StudioCloudflareTimeTravelModule` declare `imports` as a structural option.
