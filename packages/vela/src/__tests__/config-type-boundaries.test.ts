import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { Container } from '../container/container';
import { defineProvider, InjectionToken } from '../container/types';
import { ConfigService } from '../config/config.service';
import { ConfigStore } from '../config/config.store';
import { registerAs } from '../config/register-as';

function invalidConfigReads(config: ConfigService): void {
  // @ts-expect-error A reader cannot choose a fabricated config service shape.
  const typedService: ConfigService<{ port: number }> = config;
  // @ts-expect-error Raw config paths do not prove a value type.
  const port: number = config.get('port');
  // @ts-expect-error Existence alone does not prove a value type.
  const requiredPort: number = config.getOrThrow('port');
  // @ts-expect-error A reader-selected generic cannot stand in for validation.
  config.get<number>('port');
  void [typedService, port, requiredPort];
}
void invalidConfigReads;

describe('config value type boundaries', () => {
  it('keeps dynamic reads unknown and infers parser output', () => {
    const container = new Container();
    const service = new ConfigService(new ConfigStore(container, { port: '8080' }));
    expectTypeOf(service.get('port')).toEqualTypeOf<unknown>();
    expectTypeOf(service.getOrThrow('port')).toEqualTypeOf<unknown>();
    expectTypeOf(service.getAll()).toEqualTypeOf<Record<string, unknown>>();
    expect(service.parse('port', z.coerce.number().int())).toBe(8080);
    expect(() => service.parse('port', z.number())).toThrow();
  });

  it('derives config namespace values from a real declared environment token', () => {
    const env = new InjectionToken<{ port: string }>('validated environment');
    const server = registerAs('server', env, (value) => ({ port: Number(value.port) }));
    const container = new Container()
      .register(defineProvider(env, { useValue: { port: '8080' } }))
      .register(server.asProvider());
    expect(server.KEY).toBeInstanceOf(InjectionToken);
    expectTypeOf(container.resolve(server.KEY)).toEqualTypeOf<{ port: number }>();
    expect(container.resolve(server.KEY)).toEqual({ port: 8080 });
  });
});
