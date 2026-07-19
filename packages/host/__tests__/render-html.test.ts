import { describe, expect, it } from 'vitest';
import { renderMissingAssetsHtml, renderStudioHtml } from '../src/render-html';

describe('renderStudioHtml', () => {
  const base = { basePath: '/', scriptSrc: '/studio.js', styleHref: '/styles.css' } as const;

  it('always injects the SPA base path global', () => {
    const html = renderStudioHtml(base);
    expect(html).toContain('window.__VELA_BASE_PATH__="/";');
    expect(html).toContain('<script type="module" src="/studio.js">');
    expect(html).toContain('<link rel="stylesheet" href="/styles.css" />');
  });

  it('injects the browser session token ONLY under the editable opt-in', () => {
    const editable = renderStudioHtml({ ...base, adminToken: 'SESSION-123', editable: true });
    expect(editable).toContain('window.__VELA_ADMIN_TOKEN__="SESSION-123";');
    expect(editable).toContain('window.__VELA_EDITABLE__=true;');

    const readOnly = renderStudioHtml({ ...base, adminToken: 'SESSION-123', editable: false });
    expect(readOnly).not.toContain('__VELA_ADMIN_TOKEN__');
    expect(readOnly).not.toContain('__VELA_EDITABLE__');
  });

  it('emits capability flags as __VELA_CAPS__ when provided', () => {
    const html = renderStudioHtml({ ...base, caps: { schemaEditable: true } });
    expect(html).toContain('window.__VELA_CAPS__=');
    expect(html).toContain('schemaEditable');
  });

  it('neutralises </script> in injected values so the tag cannot be closed early', () => {
    const html = renderStudioHtml({ ...base, basePath: '/</script><script>alert(1)//' });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script');
  });

  it('renders a static build hint with no bundle reference', () => {
    const html = renderMissingAssetsHtml();
    expect(html).toContain('build');
    expect(html).not.toContain('<script type="module"');
  });
});
