import type { OpenApiUiOptions } from './types';
import { escapeHtml, scriptString } from './ui-escape';

// Minimal HTML shell that bootstraps Swagger UI from a CDN. Served as a
// static string so it works on every edge runtime with no Node or bundler
// deps — Swagger UI itself is loaded from a CDN at runtime.
export function renderSwaggerUi(
  specUrl: string,
  title?: string,
  options: OpenApiUiOptions = {},
): string {
  const safeUrl = scriptString(specUrl);
  const safeTitle = escapeHtml(title ?? 'API Reference');
  return `<!doctype html>
<html lang="${escapeHtml(options.lang ?? 'en')}">
  <head>
    <title>${safeTitle}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="${escapeHtml(options.styleUrl ?? 'https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui.css')}" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${escapeHtml(options.scriptUrl ?? 'https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui-bundle.js')}"></script>
    <script>
      window.ui = SwaggerUIBundle({ url: ${safeUrl}, dom_id: '#swagger-ui' });
    </script>
  </body>
</html>`;
}
