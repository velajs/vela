---
"@velajs/storage": patch
---

Report actual native R2 range lengths and reject invalid ranges before I/O. Enforce storage deadlines and cancellation without retrying abandoned operations whose writes may still commit. Dispose late download bodies and multipart handles, stop follow-up mutations after cancellation, and document provider-side uncertainty and stream ownership.
