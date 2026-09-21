---
"@velajs/graphql": patch
---

Validate GraphQL route paths with linear scans instead of a regex that could backtrack exponentially on long invalid input. Preserve root and literal ASCII path segments while rejecting empty segments, trailing separators, and disallowed characters.
