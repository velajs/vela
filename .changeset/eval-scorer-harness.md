---
"@velajs/testing": minor
---

Add `@velajs/testing/eval`: a small, model-agnostic harness for scoring the output of any string-producing function. Ships heuristic scorers (`exactMatch`, `contains`, `keyword`, `regex`), an `llmScorer` LLM-as-judge whose `judge` callback is injected (no AI SDK dependency, fails soft on unparseable replies), and `evaluate(dataset, run, scorers)` which returns per-case reports plus a per-scorer and overall aggregate.
