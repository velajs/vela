---
'@velajs/vela': minor
---

WebSocket hardening:

- A gateway serves the `@SubscribeMessage()` handlers an ancestor class declares on methods it inherits unchanged, as in Nest and like the other declarations a class inherits. Its own declaration of an event wins, and a method it overrides without the decorator is not a handler.
- The message of the `AggregateError` a multi-room `Gateways` push rejects with shortens each room id it names to 32 characters, so it stays bounded whatever the ids (still the first ten rooms, then how many more); each entry of `errors` names its room in full.

**Behavior change:** a gateway handles the events an ancestor class declares with `@SubscribeMessage()` on methods the gateway inherits unchanged, through the guards, pipes, interceptors and filters that apply to those methods. Previously only the gateway's own declarations were handlers, and those events were ignored like any unknown event. Override such a method without the decorator, or remove the declaration from the ancestor, where a gateway must not serve it.

**Behavior change:** a gateway whose module sees two or more `WS_SERVER` providers fails bootstrap, naming each providing module, also when they all come from `WebSocketModule` instances it imports. Previously several `WebSocketModule` instances were accepted and the server of whichever dispatcher connected the gateway first served it. Import one `WebSocketModule` instance in the gateway's module, or provide `WS_SERVER` in the gateway's module itself.
