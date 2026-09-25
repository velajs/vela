---
'@velajs/studio-protocol': minor
'@velajs/studio-ui': minor
'@velajs/studio-host': minor
---

The Studio wire protocol moves to version 4 (`STUDIO_PROTOCOL_VERSION`): `app.modules` rows name a module's visibility flag `global` instead of `isGlobal` (`ModuleNode.global`), as `@velajs/vela` 1.32.0 names it in its module descriptions. `@velajs/studio-ui` reads `global` for the modules panel's badge. `@velajs/studio-host` changes only to ship protocol 4: it depends on the exact `@velajs/studio-protocol` release and emits a protocol-4 connection. `@velajs/studio-host` 1.24.0 declares its optional `@velajs/studio-ui` peer as `^1.25.0`, where 1.23.0 declared `^1.24.0`.

**Behavior change:** there is no compatibility path for protocol 3. The UI refuses a host connection or a Studio server on another protocol version, so upgrade `@velajs/studio` 1.32.0, `@velajs/studio-host` 1.24.0 and `@velajs/studio-ui` 1.25.0 together.
