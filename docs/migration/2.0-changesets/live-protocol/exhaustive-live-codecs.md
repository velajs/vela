---
'@velajs/live-protocol': major
---

Return the discriminated LiveFrame type from canonicalLiveFrame, constructing canonical frames and row operations through exhaustive typed variants. Use keyed map iteration in the shared delta codec instead of type assertions. Reject accessor-backed and non-JSON own properties at the unknown input boundary without executing application getters. Valid JSON wire frames retain their exact canonical encoding.

Export defineLiveQuery and LiveQueryDefinition as the shared, dependency-free args/result parser contract for server resolvers and typed clients.
