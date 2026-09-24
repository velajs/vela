---
'@velajs/cli': patch
---

`vela client generate` accepts query parameters documented with `style: form` and `explode: true`, the repeated-key serialization Vela now documents for array query parameters and `hc` sends. Other parameter styles, `explode: false` and styled path or header parameters still fail generation.
