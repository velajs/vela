import { defineProvider, Reflector, type ExecutionContext } from '@velajs/vela';
import {
  Container,
  bindTrustedRequestContext,
  getTrustedRequestIdentity,
  setTrustedRequestIdentity,
  clearTrustedRequestIdentity,
} from '@velajs/vela/module-kit';
import { createAuthz } from '../../authz';
import { AUTHZ } from '../tokens';
import { PermissionGuard } from '../permission.guard';
import { RequirePermission } from '../require-permission.decorator';
import type { WsClient } from '@velajs/vela/websocket';
import { describe, expect, it } from 'vitest';
import { getContextIdentity, identityFromTrusted } from '../context-identity';

function context(data: Record<string, unknown>, container?: Container): ExecutionContext {
  class Socket implements WsClient {
    id = 'socket-1';
    rooms = new Set<string>();
    raw = undefined;
    // Cloudflare hibernated clients expose data through a prototype getter.
    get data() {
      return data;
    }
    send() {}
    sendRaw() {}
    join() {}
    leave() {}
    commit() {}
    close() {}
  }
  return {
    getType: () => 'ws',
    getClass: () => Socket,
    getHandler: () => 'message',
    getModuleId: () => '__root__',
    getContainer: () => container,
    getContext() {
      throw new Error('HTTP accessor called');
    },
    getRequest() {
      throw new Error('HTTP accessor called');
    },
    switchToHttp() {
      throw new Error('HTTP accessor called');
    },
    switchToWs: () => ({
      getClient: () => new Socket(),
      getData: () => ({ role: 'admin' }),
      getPattern: () => 'message',
    }),
  };
}

const attachment = () => ({
  principal: { issuer: 'issuer', subject: 'user', principalType: 'user' },
  tenantId: 'tenant',
  expiresAtMs: Date.now() + 60_000,
});

it('requires explicit HTTP backing for custom contexts and observes identity invalidation', async () => {
  const request = new Request('https://test.invalid');
  setTrustedRequestIdentity(request, {
    principal: { issuer: 'accounts', subject: 'alice', principalType: 'user' },
  });
  const container = new Container();
  let replace = false;
  container.register(
    defineProvider(AUTHZ, {
      useValue: createAuthz({
        resolver: {
          grants: async () => {
            await Promise.resolve();
            if (replace) setTrustedRequestIdentity(request, getTrustedRequestIdentity(request)!);
            return new Set(['read']);
          },
        },
      }),
    }),
  );
  const ctx = { ...context({}, container), getType: () => 'graphql', getRequest: () => request };
  RequirePermission(['read'])(ctx.getClass());
  expect(getContextIdentity(ctx)).toBeUndefined();
  await expect(new PermissionGuard(new Reflector()).canActivate(ctx)).rejects.toThrow(
    'Access denied',
  );
  bindTrustedRequestContext(ctx, request);
  expect(getContextIdentity(ctx)?.principal.subject).toBe('alice');
  await expect(new PermissionGuard(new Reflector()).canActivate(ctx)).resolves.toBe(true);
  replace = true;
  await expect(new PermissionGuard(new Reflector()).canActivate(ctx)).rejects.toThrow(
    'Access denied',
  );
  clearTrustedRequestIdentity(request);
  expect(getContextIdentity(ctx)).toBeUndefined();
});

describe('WebSocket authorization isolation', () => {
  it('uses the normalized connection attachment through the real getter shape', () => {
    const identity = getContextIdentity(context(attachment()));
    expect(identity).toMatchObject({
      principal: { issuer: 'issuer', subject: 'user' },
      tenantId: 'tenant',
    });
    if (!identity) throw new Error('expected identity');
    expect(identityFromTrusted(identity)).toMatchObject({
      issuer: 'issuer',
      subject: 'user',
      tenantId: 'tenant',
      roles: [],
    });
  });

  it('never promotes arbitrary socket role metadata or frame payload to authority', () => {
    const identity = getContextIdentity(
      context({ ...attachment(), roles: ['admin'], claims: { role: 'admin' } }),
    );
    expect(identity?.roles).toBeUndefined();
    expect(identity?.claims).toBeUndefined();
    expect(getContextIdentity(context({ roles: ['admin'] }))).toBeUndefined();
  });

  it('rejects expired, missing-tenant and malformed principal attachments', () => {
    expect(
      getContextIdentity(context({ ...attachment(), expiresAtMs: Date.now() - 1 })),
    ).toBeUndefined();
    expect(getContextIdentity(context({ ...attachment(), tenantId: undefined }))).toBeUndefined();
    expect(
      getContextIdentity(context({ ...attachment(), principal: { subject: 'user' } })),
    ).toBeUndefined();
  });
});

it('denies a WebSocket identity replacement while an async permission is being resolved', async () => {
  const data = attachment();
  const container = new Container();
  container.register(
    defineProvider(AUTHZ, {
      useValue: createAuthz({
        resolver: {
          grants() {
            data.tenantId = 'other-tenant';
            return new Set(['posts:write']);
          },
        },
      }),
    }),
  );
  const ctx = context(data, container);
  RequirePermission(['posts:write'])(ctx.getClass());
  await expect(new PermissionGuard(new Reflector()).canActivate(ctx)).rejects.toThrow(
    'Access denied',
  );
});
