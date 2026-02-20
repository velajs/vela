# Changelog

## 0.1.0 (2026-02-19)

Initial release.

- Decorator-based controllers with full HTTP method support
- Dependency injection with singleton, transient, and request scopes
- Module system with imports, exports, and dynamic modules
- Guards, pipes, interceptors, exception filters, and middleware
- Built-in pipes: ParseIntPipe, ParseFloatPipe, ParseBoolPipe, DefaultValuePipe, RequiredPipe, ZodValidationPipe
- 18 built-in HTTP exceptions
- Custom metadata with SetMetadata + Reflector
- Custom parameter decorators via createParamDecorator
- Route versioning
- Global prefix support
- Lifecycle hooks
- Optional hono-crud integration via `vela/crud`
- Edge runtime compatible (Cloudflare Workers, Deno, Bun, Node.js 20+)
