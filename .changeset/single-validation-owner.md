---
"@velajs/vela": patch
"@velajs/crud": patch
---

Validate generated CRUD request bodies once in the engine, preserving schema metadata for OpenAPI without storing global validation receipts. Headless calls validate raw input independently. Keep consumeValidated as a deprecated compatibility method that returns false. Awaited CRUD identifier, body, persisted-row and response contracts use the shared async parser to avoid speculative Zod transforms. ValidationPipe adds transformAsync while preserving its synchronous transform API.
