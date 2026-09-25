---
'@velajs/cli': patch
---

`vela client generate` accepts query parameters documented with `style: form` and `explode: true`, the repeated-key serialization Vela now documents for array query parameters and `hc` sends. A parameter whose schema is a `oneOf` or `anyOf` of values, such as the one value or repeated keys Vela documents for a union or `unknown` named query parameter, is typed as the union of its members (`string | Array<string>`); an object member still fails generation. Other parameter styles, `explode: false` and styled path or header parameters still fail generation.
