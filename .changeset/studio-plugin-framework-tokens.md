---
'@velajs/studio': patch
---

`StudioModule.forRoot({ plugins })` and `forRootAsync` fail, naming the plugin and the token, when a plugin provides a framework token StudioModule injects from the application: `ENV`, `APP_LOGGER`, `ROOT_MODULE`, `Container`, `DiscoveryService`, `EntrypointRegistry`, `ModuleRef` or `Reflector`. Plugin providers register in Studio's scope, where such a provider answered before the application's own, so Studio read the panel's `ENV` (its admin token among it), logged through the panel's logger or described another root module.
