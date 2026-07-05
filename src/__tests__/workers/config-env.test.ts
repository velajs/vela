import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  VelaFactory,
  Module,
  Global,
  ConfigModule,
  ConfigService,
  CONFIG_ENV,
  registerAs,
} from '../../index';

// Live workerd (miniflare) validation of config namespaces on the bare
// edge-runtime contract (no nodejs_compat — see wrangler.toml): CONFIG_ENV is
// seeded from the Workers `env` (the c.env binding source), and a `registerAs`
// factory reads it — proving env reaches config without `process.env`.

interface WorkersEnv {
  CONFIG_DATABASE_URL?: string;
}

const dbConfig = registerAs('database', (e: WorkersEnv) => ({
  url: e.CONFIG_DATABASE_URL ?? 'unset',
}));

// A @Global module provides CONFIG_ENV from the Workers env — how a platform
// adapter would wire it. `env` here is the miniflare-provided binding bag.
@Global()
@Module({
  providers: [{ provide: CONFIG_ENV, useValue: env as unknown as Record<string, unknown> }],
  exports: [CONFIG_ENV],
})
class WorkersEnvModule {}

@Module({
  imports: [WorkersEnvModule, ConfigModule.forRoot({ load: [dbConfig], isGlobal: true })],
})
class SeededConfigModule {}

@Module({
  imports: [ConfigModule.forRoot({ load: [dbConfig], isGlobal: true })],
})
class BareConfigModule {}

describe('config namespaces on Cloudflare Workers (live miniflare)', () => {
  it('seeds CONFIG_ENV from the Workers env and reads a namespace under workerd', async () => {
    const app = await VelaFactory.create(SeededConfigModule);
    const cfg = app.get(ConfigService);
    expect(cfg.get('database.url')).toBe('postgres://edge/db');
  });

  it('defaults CONFIG_ENV to {} when no binding provides it', async () => {
    const app = await VelaFactory.create(BareConfigModule);
    expect(app.get(CONFIG_ENV)).toEqual({});
    expect(app.get(ConfigService).get('database.url')).toBe('unset');
  });
});
