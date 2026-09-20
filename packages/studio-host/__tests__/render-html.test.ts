import { describe, expect, it } from 'vitest';
import { renderMissingAssetsHtml, renderStudioHtml } from '../src/render-html';
import type { StudioConnection } from '@velajs/studio-protocol';

const connection: StudioConnection = {
  protocolVersion: 2,
  routerBasePath: '/tools',
  adminBasePath: '/api/admin',
  apiRequestPath: '/api/admin/api-request',
  sessionToken: 'SESSION-123',
};

describe('Studio bootstrap HTML', () => {
  it('always emits the typed session and both paths without capability overrides', () => {
    const html = renderStudioHtml({
      connection,
      scriptSrc: '/tools/studio.js',
      styleHref: '/tools/styles.css',
    });
    expect(html).toContain(`window.__VELA_STUDIO__=${JSON.stringify(connection)};`);
    expect(html).toContain('src="/tools/studio.js"');
    expect(html).not.toContain('__VELA_CAPS__');
  });
  it('escapes script closing tags in serialized configuration', () => {
    const html = renderStudioHtml({
      connection: { ...connection, sessionToken: '</script><script>' },
      scriptSrc: '/studio.js',
      styleHref: '/styles.css',
    });
    expect(html).not.toContain('</script><script>');
    expect(html).toContain('\\u003c/script');
  });
  it('renders a build hint when assets are absent', () => {
    expect(renderMissingAssetsHtml()).toContain('build');
    expect(renderMissingAssetsHtml()).not.toContain('<script type="module"');
  });
});
