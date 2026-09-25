---
'@velajs/studio': patch
---

The admin routes and `studioRuntimeAdapter` read Studio's own `STUDIO_RESOLVED_CONFIG`, `AdminSubTokenSigner`, `StudioDispatchRegistry` and `StudioAppHolder` in StudioModule's scope. They looked them up application-wide, where a module registering one of them without exporting it answered when it loaded before StudioModule, as a module a plugin imports does: the admin surface then accepted that module's token, minted sub-tokens with its signer and filled its route holder.
