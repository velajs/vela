---
'@velajs/ai': minor
---

Separate RAG publication, ACLs and text from candidate search using required transactional publication storage, revision compare-and-swap, tombstones and resumable indexing journals. Replace the vector contract with explicit mutation acknowledgments and nonnegative scores; remove in-index manifests and the optional text-store API. Add an optional Vectorize V2 driver, Durable Object publication storage, native recipe and bounded opt-in live acceptance fixture. Replacements require current revision tokens and old data must be re-indexed into a fresh partition.
