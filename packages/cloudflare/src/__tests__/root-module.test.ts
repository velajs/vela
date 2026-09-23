import { beforeEach, describe, expect, it } from 'vitest';
import { ENV, Injectable, MetadataRegistry, Module } from '@velajs/vela';
import type { OnModuleInit, VelaEnv } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import { resolveCloudflareRoot } from '../root-module';

beforeEach(() => {
  MetadataRegistry.clear();
});

function feature() {
  @Injectable()
  class Service {}

  @Module({ providers: [Service], exports: [Service] })
  class Feature {}
  return { Feature, Service };
}

describe('Cloudflare root resolution', () => {
  it('runs a { create(env) } root once per environment across applications', async () => {
    const { Feature, Service } = feature();
    const calls: string[] = [];
    const root = {
      create: (env: VelaEnv) => {
        calls.push(String(Reflect.get(env, 'NAME')));
        return { module: Feature };
      },
    };
    const a = { NAME: 'a' };
    const b = { NAME: 'b' };

    const first = await createCloudflareApp(root, { env: a });
    const second = await createCloudflareApp(root, { env: a });
    const other = await createCloudflareApp(root, { env: b });

    expect(calls).toEqual(['a', 'b']);
    expect(await resolveCloudflareRoot(root, a)).toBe(await resolveCloudflareRoot(root, a));
    // Sharing the resolved module graph never shares application state.
    expect(first.get(Service)).not.toBe(second.get(Service));
    expect(second.get(ENV)).toBe(a);
    expect(other.get(ENV)).toBe(b);
    await Promise.all([first.close(), second.close(), other.close()]);
  });

  it('wraps a dynamic root once per environment', async () => {
    const { Feature } = feature();
    const root = { module: Feature };
    const env = { NAME: 'dynamic' };

    const wrapper = await resolveCloudflareRoot(root, env);

    expect(await resolveCloudflareRoot(root, env)).toBe(wrapper);
    expect(await resolveCloudflareRoot(root, { NAME: 'replaced' })).not.toBe(wrapper);
  });

  it('runs the factory again after a failed bootstrap', async () => {
    let attempts = 0;

    @Injectable()
    class Flaky implements OnModuleInit {
      onModuleInit(): void {
        if (attempts === 1) throw new Error('transient bootstrap failure');
      }
    }

    @Module({ providers: [Flaky] })
    class FlakyModule {}

    const root = {
      create: () => {
        attempts++;
        return FlakyModule;
      },
    };
    const env = { NAME: 'retry' };

    await expect(createCloudflareApp(root, { env })).rejects.toThrow('transient bootstrap failure');
    const app = await createCloudflareApp(root, { env });

    expect(attempts).toBe(2);
    await app.close();
  });
});
