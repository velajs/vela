---
'@velajs/vela': minor
---

Allow context parameters on `@Endpoint` handlers. Parameter 0 remains the validated input; later parameters may use `createParamDecorator` and `createLazyParamDecorator` decorators, `@Req()`, `@Res()`, `@Ip()`, and `@Cookie()`. They resolve after guards and input validation through the ordinary argument resolver, pipes, and request container, so identity decorators such as `@CurrentUser()` no longer require a request-scoped controller.

Decorators that read request data owned by the endpoint input (`@Param()`, `@Query()`, `@Headers()`, `@Body()`, `@RawBody()`), any decorator on the input parameter, `@HttpCode`, and `@Redirect` are still rejected, both at startup and during OpenAPI generation, with a specific message. OpenAPI documents and generated clients ignore context parameters, and the `@Endpoint` method type accepts parameters after the input while still checking the input and result types. Headers and cookies set on the request context, for example through `@Res()`, now also apply to binary and stream endpoint bodies.
