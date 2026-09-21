---
'@velajs/vela': patch
---

Resolve useExisting targets from the alias's declaring module after checking visibility of the alias.
Exported aliases can reference their module's private implementation, consumer shadowing no longer
rewires aliases, and unqualified aliases in different modules retain their respective targets.
Aliases to another module's unexported providers remain rejected.
