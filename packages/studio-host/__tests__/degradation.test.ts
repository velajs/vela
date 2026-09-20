import { describe, expect, it, vi } from 'vitest';

// Force the asset loaders to report an absent UI, so the handler's graceful
// build-hint branch is exercised deterministically (vitest's resolver otherwise
// resolves the workspace UI regardless of `resolveFrom` — see assets.test.ts).
vi.mock('../src/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/assets')>();
  return {
    ...actual,
    loadStudioAssets: () => undefined,
    studioAssetsStamp: () => undefined,
    readStandaloneAsset: () => undefined,
    resolveStandaloneDirectory: () => undefined,
  };
});

const { createStudioHandler } = await import('../src/handler');
const { resolveOptions } = await import('../src/options');

describe('graceful degradation when the UI bundle is absent', () => {
  const handle = createStudioHandler(resolveOptions({ workerOrigin: 'http://127.0.0.1:1' }));

  it('serves the static build-hint document (503) with no bundle reference', async () => {
    const res = await handle(new Request('http://127.0.0.1/'), '127.0.0.1');
    expect(res?.status).toBe(503);
    const body = (await res?.text()) ?? '';
    expect(body).toContain("isn't built yet");
    expect(body).not.toContain('<script type="module"');
  });

  it('answers 503 for a bundle asset request', async () => {
    const res = await handle(new Request('http://127.0.0.1/studio.js'), '127.0.0.1');
    expect(res?.status).toBe(503);
  });
});
