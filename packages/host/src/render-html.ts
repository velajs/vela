/**
 * Render the single-page document that boots Vela Studio. Emitted verbatim —
 * never through a bundler — so the Studio stays a static tool decoupled from the
 * app's build. A small inline script publishes per-server config on `window`
 * before the bundle loads (the M3/M6 `window.__VELA_*` contract read by the
 * standalone entry): the SPA base path, and — only under the editable opt-in — a
 * NON-secret browser session token plus capability flags.
 *
 * The master admin token is NEVER injected here: the browser talks only to the
 * loopback host, which adds the `Authorization: Bearer` server-side in the proxy.
 * {@link StudioHtmlConfig.adminToken} is the browser session token (a marker that
 * lets the Studio skip its login screen and auto-auth through the proxy), not the
 * master credential.
 */

/** Config injected into the Studio document before the bundle loads. */
export interface StudioHtmlConfig {
  /** SPA router base path — fed to `window.__VELA_BASE_PATH__` → `routerBasePath`. */
  readonly basePath: string;
  /** URL the bundle entry (`studio.js`) is served from (absolute, host-relative). */
  readonly scriptSrc: string;
  /** URL the stylesheet (`styles.css`) is served from (absolute, host-relative). */
  readonly styleHref: string;
  /**
   * NON-secret browser session token, injected as `window.__VELA_ADMIN_TOKEN__`
   * only when {@link editable} is true. NEVER the master admin token.
   */
  readonly adminToken?: string;
  /**
   * Developer-only editable mode. Gates injection of {@link adminToken} (so the
   * Studio auto-auths through the proxy) and emits `window.__VELA_EDITABLE__`.
   */
  readonly editable?: boolean;
  /** Optional capability flags emitted as `window.__VELA_CAPS__` (M3/M6 contract). */
  readonly caps?: Readonly<Record<string, unknown>>;
  /** Document title; defaults to `Vela Studio`. */
  readonly title?: string;
}

/**
 * Serialise a string for safe inline-script embedding: JSON-encode it, then
 * neutralise `<` so a `</script>` (or comment opener) in the value can't end the
 * tag early.
 */
const forInlineScript = (value: string): string => JSON.stringify(value).replaceAll('<', '\\u003c');

/** Escape a value for embedding inside a double-quoted HTML attribute. */
const forAttribute = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

export function renderStudioHtml(config: StudioHtmlConfig): string {
  const settings: string[] = [`window.__VELA_BASE_PATH__=${forInlineScript(config.basePath)};`];

  // The session token + editable flag are developer-only affordances, injected
  // only under the loopback editable opt-in. The master token is never here.
  if (config.editable === true) {
    if (config.adminToken !== undefined && config.adminToken !== '') {
      settings.push(`window.__VELA_ADMIN_TOKEN__=${forInlineScript(config.adminToken)};`);
    }
    settings.push('window.__VELA_EDITABLE__=true;');
  }

  if (config.caps !== undefined) {
    settings.push(`window.__VELA_CAPS__=${forInlineScript(JSON.stringify(config.caps))};`);
  }

  const title = config.title ?? 'Vela Studio';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${forAttribute(title)}</title>
    <script>${settings.join('')}</script>
    <link rel="stylesheet" href="${forAttribute(config.styleHref)}" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${forAttribute(config.scriptSrc)}"></script>
  </body>
</html>
`;
}

/**
 * The graceful-degradation page served when `@velajs/studio-ui` isn't installed
 * or hasn't been built — a static hint, no bundle reference, so a missing UI
 * never breaks the dev host.
 */
export function renderMissingAssetsHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vela Studio — build required</title>
  </head>
  <body>
    <main style="font-family: system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1rem;">
      <h1>Vela Studio isn't built yet</h1>
      <p>The standalone Studio bundle couldn't be resolved. Install and build the UI:</p>
      <pre style="background:#f4f4f5; padding:1rem; border-radius:8px; overflow:auto;"><code>pnpm add @velajs/studio-ui
pnpm --filter @velajs/studio-ui build</code></pre>
      <p>Then reload this page.</p>
    </main>
  </body>
</html>
`;
}
