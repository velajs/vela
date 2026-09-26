import { describe, expect, it, vi } from 'vitest';
import { defineProvider, Reflector } from '@velajs/vela';
import {
  Container,
  createExecutionScope,
  buildEntrypointExecutionContext,
  setTrustedContextIdentity,
  getTrustedContextIdentity,
  clearTrustedContextIdentity,
} from '@velajs/vela/module-kit';
import { CEDAR_AUTHORIZER, CedarGuard, RequireResource } from '../vela/index';

describe('native Cedar authority', () => {
  it.each(['valid', 'missing', 'clear', 'replace', 'expire', 'dispose'] as const)(
    'uses canonical identity with %s authority and never a native fallback',
    async (mode) => {
      class Native {
        read() {}
      }
      RequireResource({ action: 'read', resourceType: 'Document' })(Native);
      const root = new Container();
      const scope = createExecutionScope(root);
      const ctx = buildEntrypointExecutionContext(
        'rpc',
        Native,
        'read',
        [],
        '__root__',
        scope.container,
      );
      let now = 1000;
      const time = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const identity = {
        principal: { issuer: 'accounts', subject: 'alice', principalType: 'user' as const },
        expiresAtMs: 2000,
      };
      const fallback = vi.fn(() => identity);
      root.register(
        defineProvider(CEDAR_AUTHORIZER, {
          useValue: {
            identity: fallback,
            async authorize() {
              await Promise.resolve();
              if (mode === 'clear') clearTrustedContextIdentity(ctx);
              if (mode === 'replace')
                setTrustedContextIdentity(ctx, getTrustedContextIdentity(ctx)!);
              if (mode === 'expire') now = 2000;
              if (mode === 'dispose') await scope.container.dispose();
              return true;
            },
          },
        }),
      );
      try {
        if (mode !== 'missing') setTrustedContextIdentity(ctx, identity);
        const result = new CedarGuard(new Reflector()).canActivate(ctx);
        if (mode === 'valid') await expect(result).resolves.toBe(true);
        else await expect(result).rejects.toThrow();
        expect(fallback).not.toHaveBeenCalled();
      } finally {
        time.mockRestore();
        await scope.finish();
      }
    },
  );
});
