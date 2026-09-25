---
'@velajs/cloudflare': minor
---

Durable Objects are Vela entrypoints. `defineCloudflareApp(AppModule, options)` defines one application: its `worker` is the Worker's default export, and the Durable Object classes defined from it share its root module and options. `VelaDurableObject(app, Host)` from `@velajs/cloudflare/durable-objects` returns a Durable Object class whose public host methods are its JS-RPC methods:

```ts
const app = defineCloudflareApp(AppModule);
export class Counter extends VelaDurableObject(app, CounterHost) {}
export default app.worker;
// await env.COUNTER.getByName('orders').increment(1)
```

- Each instance boots one application context with `VelaFactory.createApplicationContext`, in its constructor under `blockConcurrencyWhile`. The host, an `@Injectable()`, is added to the root module's providers. The context injects the object's `ENV` and the new `DO_STATE`, `DO_STORAGE` and `DO_ID` tokens, and the app's runtime adapters configure it as they configure the Worker. `VelaDurableObject(AppModule, Host)` takes a bare root instead.
- The host's string-keyed prototype methods, its own and inherited ones, become RPC methods, typed so a `DurableObjectNamespace<Counter>` stub exposes their signatures. Lifecycle hooks and accessors are not RPC methods, and a method named `ctx`, `env`, `connect` or `dup` is rejected when the class is defined. A host's `fetch`, `alarm`, `webSocketMessage`, `webSocketClose` and `webSocketError` become the object's handlers.
- Each RPC call and event runs in its own execution scope, so request-scoped providers are built per call, through the host's scoped guards, pipes (RPC arguments only), interceptors and filters. Application-wide `APP_*` components do not apply. `ExecutionContext.getType()` is `'rpc'`, `'cf:do:fetch'`, `'cf:do:alarm'` or `'cf:do:websocket'`, and `getPayload()` is the arguments.
- Failures are reported first. An RPC call rejects only with a `DurableObjectError`, rendered like an HTTP response with server errors redacted: `status`, `code`, `message`, and `details` for a client fault. No stack frame, cause or other property of the original error crosses the RPC boundary. `isDurableObjectError()` recognizes the plain `Error` workerd delivers to the caller. A `DurableObjectError` a host rethrows, such as another object's failure, keeps its code and message for a client fault and only its status for a server fault, and a failure outside the pipeline is reported and becomes `500 internal`. `fetch()` renders the JSON error body; alarms and WebSocket events rethrow for the platform. A context that fails to start resets the object, and waiting callers receive only a redacted `500`.
- The Worker descriptor lists the Durable Object classes defined from the app (`durableObjects`), and each class carries a `CloudflareDurableObjectDescriptor` under the static `CLOUDFLARE_DURABLE_OBJECT` key, so tools know what each exported class serves. `isCloudflareApp()` recognizes an app definition.
- `createCloudflareWorker(AppModule, options)` is `defineCloudflareApp(AppModule, options).worker`.
- The host code lives in `@velajs/cloudflare/durable-objects`: the minimal `createCloudflareWorker()` Worker bundles none of it and measures 156,715 bytes raw and 52,910 bytes gzipped, 1,080 and 549 bytes more than before (mostly the core application context), within its unchanged ceiling.

**Behavior change:** `VelaWebSocketDurableObject(root)` boots through the same application context as `VelaDurableObject`, and also accepts the app from `defineCloudflareApp`, whose runtime adapters then configure it. Its context injects `DO_STATE`, `DO_STORAGE` and `DO_ID`. When its application fails to start, a waiting caller receives a redacted `DurableObjectError` (`500 internal`) instead of the startup error, which the object logs. An application that does not import `WebSocketModule` now fails after its lifecycle hooks ran, and its context is disposed.
