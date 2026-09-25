---
'@velajs/studio': minor
---

A Studio plugin can no longer replace a framework token StudioModule and its panels inject from the application: `ENV`, `APP_LOGGER`, `ROOT_MODULE`, `Container`, `DiscoveryService` or `EntrypointRegistry`. Plugin providers and the modules plugins import join Studio's scope, where such a provider, or a module export, answered before the application's own, so Studio read the panel's `ENV` (its admin token among it), logged through the panel's logger or described another root module.

**Behavior change:** `StudioModule.forRoot({ plugins })` and `forRootAsync` fail, naming the plugin and the token, when a plugin provides one of these tokens, or imports a module that exports one, directly or by re-exporting a module it imports (`exports: [EnvModule]`); a plugin import written as `forwardRef(() => Module)` fails the same way when the application loads it. Previously the plugin's registration silently replaced the application's inside Studio. Provide these tokens in the application, not in a panel, and import modules that keep them to themselves.
