import { fileURLToPath } from 'node:url';
import { loadConfig } from '@velajs/cli/config';
import { describe, expect, it } from 'vitest';

describe('vela.config.ts', () => {
  it('loads through the CLI config loader and boots the demo app', async () => {
    const { config, dispose } = await loadConfig(fileURLToPath(new URL('..', import.meta.url)));
    try {
      const app = await config.createApp();
      try {
        const routes = app.describeRoutes().map((route) => `${route.method} ${route.path}`);
        expect(routes).toContain('GET /authors');
      } finally {
        await app.close();
      }
    } finally {
      await dispose();
    }
  });
});
