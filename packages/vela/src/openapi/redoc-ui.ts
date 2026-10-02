import type { OpenApiUiOptions } from './types';
import { escapeHtml } from './ui-escape';

// Minimal HTML shell that bootstraps ReDoc from a CDN. Served as a static
// string so it works on every edge runtime with no Node or bundler deps —
// ReDoc itself is loaded from a CDN at runtime.
export function renderRedocUi(
  specUrl: string,
  title?: string,
  options: OpenApiUiOptions = {},
): string {
  const safeUrl = escapeHtml(specUrl);
  const safeTitle = escapeHtml(title ?? 'API Reference');
  return `<!doctype html>
<html lang="${escapeHtml(options.lang ?? 'en')}">
  <head>
    <title>${safeTitle}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <redoc spec-url="${safeUrl}"></redoc>
    <script src="${escapeHtml(options.scriptUrl ?? 'https://cdn.jsdelivr.net/npm/redoc/bundles/redoc.standalone.js')}"></script>
  </body>
</html>`;
}
