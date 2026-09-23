---
'@velajs/vela': patch
---

Keep more unused framework code out of Worker bundles. Exception reporting no longer pulls in `LoggingModule` and the structured logger, the route pipeline no longer imports the `@Endpoint` executor (`@Endpoint` supplies it), unused HTTP method and parameter decorators no longer keep `ValidationPipe` and the schema helpers, module-level `InjectionToken`s are marked pure, and the dynamic-module identity fingerprints ship only with the helpers that record identity inputs. Behavior is unchanged. With the per-module build and the self-registering framework services, the reference Worker in `scripts/fixtures/worker-size-entry.ts` goes from 66,783 bytes gzipped in 1.29.0 to 39,779, and the worker-size gate now fails when that Worker bundles a feature module it never uses.
