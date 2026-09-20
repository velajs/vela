// Minimal HTML shell that bootstraps ReDoc from a CDN. Served as a static
// string so it works on every edge runtime with no Node or bundler deps —
// ReDoc itself is loaded from a CDN at runtime.
export function renderRedocUi(specUrl: string, title?: string): string {
  const safeUrl = specUrl.replace(/"/g, '&quot;');
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
    <redoc spec-url="${safeUrl}"></redoc>
    <script src="https://cdn.jsdelivr.net/npm/redoc/bundles/redoc.standalone.js"></script>
  </body>
</html>`;
}
