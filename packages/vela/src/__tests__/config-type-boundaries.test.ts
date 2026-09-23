import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { Container } from '../container/container';
import { defineProvider, InjectionToken } from '../container/types';
import { ConfigService } from '../config/config.service';
import { ConfigStore } from '../config/config.store';
import { registerAs } from '../config/register-as';
import type { ConfigPath, ConfigPathValue } from '../config/config.types';
import { ENV } from '../env';

function invalidConfigReads(config: ConfigService): void {
  // @ts-expect-error An unvalidated config service cannot be relabelled with a typed shape.
  const typedService: ConfigService<{ port: number }> = config;
  // @ts-expect-error Raw config paths do not prove a value type.
  const port: number = config.get('port');
  // @ts-expect-error Existence alone does not prove a value type.
  const requiredPort: number = config.getOrThrow('port');
  // @ts-expect-error The type argument is the config path, never a caller-selected value type.
  config.get<number>('port');
  void [typedService, port, requiredPort];
}
void invalidConfigReads;

interface AppConfig {
  server: { port: number; tls: { enabled: boolean } };
  name: string;
  tags: string[];
}

function typedConfigReads(config: ConfigService<AppConfig>): void {
  expectTypeOf(config.getOrThrow('server.port')).toEqualTypeOf<number>();
  expectTypeOf(config.getOrThrow('server.tls.enabled')).toEqualTypeOf<boolean>();
  expectTypeOf(config.get('name')).toEqualTypeOf<string | undefined>();
  expectTypeOf(config.get('name', 'fallback')).toEqualTypeOf<string>();
  expectTypeOf(config.getOrThrow('tags')).toEqualTypeOf<string[]>();
  // @ts-expect-error unknown paths are rejected
  config.get('server.host');
  // @ts-expect-error arrays are leaves, not path segments
  config.get('tags.0');
  // @ts-expect-error a default must match the value at the path
  config.get('server.port', 'eighty');
}
void typedConfigReads;

// A self-referential shape still type-checks: path expansion stops at the depth cap.
interface Tree {
  label: string;
  child: Tree;
}
expectTypeOf<ConfigPathValue<Tree, 'child.child.label'>>().toEqualTypeOf<string>();
expectTypeOf<'child.child.child.label'>().toExtend<ConfigPath<Tree>>();

describe('config value type boundaries', () => {
  it('keeps dynamic reads unknown and infers parser output', () => {
    const container = new Container();
    const service = new ConfigService(new ConfigStore(container, { port: '8080' }));
    expectTypeOf(service.get('port')).toEqualTypeOf<unknown>();
    expectTypeOf(service.getOrThrow('port')).toEqualTypeOf<unknown>();
    expectTypeOf(service.get('nested.path')).toEqualTypeOf<unknown>();
    expectTypeOf(service.getAll()).toEqualTypeOf<Record<string, unknown>>();
    expect(service.parse('port', z.coerce.number().int())).toBe(8080);
    expect(() => service.parse('port', z.number())).toThrow();
  });

  it('derives config namespace values from the seeded framework environment', () => {
    const server = registerAs('server', (env) => {
      const port: unknown = Reflect.get(env, 'PORT');
      return { port: typeof port === 'string' ? Number(port) : 3000 };
    });
    const container = new Container();
    container
      .register(defineProvider(Container, { useValue: container }))
      .register(defineProvider(ENV, { useValue: { PORT: '8080' } }))
      .register(server.asProvider());
    expect(server.KEY).toBeInstanceOf(InjectionToken);
    expectTypeOf(container.resolve(server.KEY)).toEqualTypeOf<{ port: number }>();
    expect(container.resolve(server.KEY)).toEqual({ port: 8080 });
  });
});
