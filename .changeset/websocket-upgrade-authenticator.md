---
"@velajs/vela": minor
---

WebSocket gateways authenticate upgrades through dependency injection. `@WebSocketGateway({ authenticator })` names a class implementing the new `UpgradeAuthenticator` interface (`authenticate(request, context)` returns a `WebSocketUpgradeIdentity` or `false`). Each application resolves it once from the module that declares the gateway, reusing a provider that module can see or constructing the class with what that module can inject (also when another module registers it without exporting it), and serves every later upgrade with the same instance. A gateway without an authenticator still refuses every upgrade, and an authenticator that throws or returns an invalid identity refuses the upgrade. Because that one instance is built once per application, an authenticator must not be request-scoped: one that declares `Scope.REQUEST` or injects a request-scoped provider, registered or not, is a configuration error. An authenticator the declaring module cannot construct, or a request-scoped one, fails the upgrade as a server error instead of admitting it.

`allowedOrigins` also accepts `(env) => origins`, read from the application's `ENV` once per application. `'*'` remains a static opt-out.

Transports bind a gateway to one application with `createWebSocketUpgradeGate(container, { options, moduleId })`, which runs the credential-parameter checks, the ticket extraction, Origin and `authorizeUpgrade`, and then the authenticator.

**Behavior change:** the `authenticateUpgrade` closure option of `@WebSocketGateway` is removed, with no alias. Move its body into a class, `class SessionAuthenticator implements UpgradeAuthenticator { authenticate(request, context) { ... } }`, and pass `authenticator: SessionAuthenticator`; inject what the closure captured. The `authenticateWebSocketUpgrade(options, request, room)` and `authorizeWebSocketUpgrade(options, request)` helpers are removed from `@velajs/vela/websocket`; use `createWebSocketUpgradeGate(container, gateway)` and call the returned gate with `(request, room)`.
