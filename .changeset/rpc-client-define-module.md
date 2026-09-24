---
'@velajs/rpc': minor
---

Build `RpcClientModule` on `defineModule`; `name` and `binding` are its structural options (`RpcClientStructuralOption`).

**Behavior change:** `RpcClientModule.register` and `RpcClientModule.registerAsync` are renamed `RpcClientModule.forRoot` and `RpcClientModule.forRootAsync`, with no alias. `forRootAsync` takes `name` and `binding` next to its factory, which returns the transport settings (`url`, `fetch`, ...); `RpcClientAsyncOptions` changes accordingly. The synchronous options no longer accept `imports`. A second configuration of a client name fails bootstrap; two registrations of one name under different keys still fail with the duplicate-client error.
