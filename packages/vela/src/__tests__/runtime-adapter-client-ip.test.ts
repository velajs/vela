import { describe, expect, it } from 'vitest';
import { Controller, Get, Ip, Module, VelaFactory } from '../index.js';
import type { RuntimeAdapter } from '../module-kit.js';

describe('runtime adapter client-IP trust boundary', () => {
  @Controller('/adapter-ip')
  class IpController {
    @Get()
    get(@Ip() ip: string | null) {
      return { ip };
    }
  }

  @Module({ controllers: [IpController] })
  class AppModule {}

  const trustedAdapter: RuntimeAdapter = {
    name: 'trusted-runtime',
    getClientIp: (c) => c.req.header('x-runtime-attested-ip') ?? null,
  };

  it('uses the single runtime adapter resolver and ignores forwarding headers', async () => {
    const app = await VelaFactory.create(AppModule, { adapters: [trustedAdapter] });
    const response = await app.getHonoApp().request('/adapter-ip', {
      headers: {
        'x-runtime-attested-ip': '203.0.113.8',
        'x-forwarded-for': 'attacker',
      },
    });
    expect(await response.json()).toEqual({ ip: '203.0.113.8' });
  });

  it('rejects ambiguous explicit and multi-adapter resolvers', async () => {
    await expect(
      VelaFactory.create(AppModule, {
        getClientIp: () => 'explicit',
        adapters: [trustedAdapter],
      }),
    ).rejects.toThrow(/either explicitly or through a runtime adapter/);

    await expect(
      VelaFactory.create(AppModule, {
        adapters: [trustedAdapter, { name: 'second', getClientIp: () => 'second' }],
      }),
    ).rejects.toThrow(/Multiple runtime adapters provide getClientIp/);
  });
});
