---
"@velajs/vela": minor
---

Add `scope` to `@Controller` options, so `@Controller({ path, scope: Scope.REQUEST })` declares a request-scoped controller.

**Behavior change:** Class decorators record a scope only when one is passed. `@Controller`, `@WebSocketGateway` and `@Seeder` no longer reset the class to singleton, so `@Injectable({ scope })` takes effect whichever side of them it is written on; a class that declares no scope is still a singleton. Declaring two different scopes on one class, for example `@Controller({ scope: Scope.REQUEST })` with `@Injectable({ scope: Scope.TRANSIENT })`, now throws when the class is decorated instead of letting decorator order pick one.
