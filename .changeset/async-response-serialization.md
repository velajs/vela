---
'@velajs/vela': patch
---

Await output serialization for legacy async parsers and Standard Schema DTOs,
including array items, and reject malformed serializer metadata instead of
passing unfiltered responses through. Existing item-per-array semantics remain.
