import type { StudioConnection } from '@velajs/studio-protocol';

/** Config injected into the Studio document before the bundle loads. */
export interface StudioHtmlConfig {
  readonly connection: StudioConnection;
  /** URL the bundle entry (`studio.js`) is served from (absolute, host-relative). */
  readonly scriptSrc: string;
  /** URL the stylesheet (`styles.css`) is served from (absolute, host-relative). */
  readonly styleHref: string;
  /** Document title; defaults to `Vela Studio`. */
  readonly title?: string;
}

/** Escape a value for embedding inside a double-quoted HTML attribute. */
const forAttribute = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

export function renderStudioHtml(config: StudioHtmlConfig): string {
  const settings = `window.__VELA_STUDIO__=${JSON.stringify(config.connection).replaceAll('<', '\\u003c')};`;

  const title = config.title ?? 'Vela Studio';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${forAttribute(title)}</title>
    <script>${settings}</script>
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
