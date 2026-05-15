// Minimal HTML shell that bootstraps Scalar's hosted API-reference UI.
// Served as a static string so it works on every edge runtime with no
// Node or bundler deps. Scalar itself is loaded from a CDN at runtime.
export function renderScalarUi(jsonUrl: string, title?: string): string {
  const safeUrl = jsonUrl.replace(/"/g, '&quot;');
  const safeTitle = (title ?? 'API Reference')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html>
<html>
  <head>
    <title>${safeTitle}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="${safeUrl}"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
}
