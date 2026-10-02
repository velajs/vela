import type { OpenApiUiOptions } from './types';
import { escapeHtml } from './ui-escape';

// Minimal HTML shell that bootstraps Scalar's hosted API-reference UI.
// Served as a static string so it works on every edge runtime with no
// Node or bundler deps. Scalar itself is loaded from a CDN at runtime.
export function renderScalarUi(
  jsonUrl: string,
  title?: string,
  options: OpenApiUiOptions = {},
): string {
  const safeUrl = escapeHtml(jsonUrl);
  const safeTitle = escapeHtml(title ?? 'API Reference');
  return `<!doctype html>
<html lang="${escapeHtml(options.lang ?? 'en')}">
  <head>
    <title>${safeTitle}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="${safeUrl}"></script>
    <script src="${escapeHtml(options.scriptUrl ?? 'https://cdn.jsdelivr.net/npm/@scalar/api-reference')}"></script>
  </body>
</html>`;
}
