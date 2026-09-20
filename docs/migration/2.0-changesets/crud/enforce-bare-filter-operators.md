---
'@velajs/crud': patch
---

Apply per-field operator allow-lists to bare equality filters as well as bracket filters. A field configured without `eq`, including an empty operator list, can no longer enable equality filtering through `?field=value`.
