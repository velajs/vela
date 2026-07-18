---
"@velajs/testing": major
---

Target the published Vela 1.21 security release and use Vela's production bootstrap primitive so request context, global providers, and request-scoped test execution cannot drift from the real runtime. Standalone CI no longer relies on a sibling `link:../vela` checkout.
