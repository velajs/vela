import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { VelaFactory, Module, ConfigModule, ConfigService, ENV, registerAs } from '../../index.js';

// Live workerd (miniflare) validation of config namespaces on the bare
// edge-runtime contract (no nodejs_compat — see wrangler.toml): the Workers
// `env` seeds the framework ENV and a `registerAs` factory reads it, proving
// env reaches config without `process.env` or `cloudflare:workers`.

const dbConfig = registerAs('database', (bindings) => {
  const url: unknown = Reflect.get(bindings, 'CONFIG_DATABASE_URL');
  return { url: typeof url === 'string' ? url : 'unset' };
});

@Module({ imports: [ConfigModule.forRoot({ load: [dbConfig], isGlobal: true })] })
class ConfigRoot {}

describe('config namespaces on Cloudflare Workers (live miniflare)', () => {
  it('seeds ENV from the Workers env and reads a namespace under workerd', async () => {
    const app = await VelaFactory.create(ConfigRoot, { env });
    expect(app.get(ENV)).toBe(env);
    expect(app.get(ConfigService).get('database.url')).toBe('postgres://edge/db');
  });

  it('fails a namespace read clearly when no runtime seeded ENV', async () => {
    const app = await VelaFactory.create(ConfigRoot);
    expect(() => app.get(ConfigService).get('database.url')).toThrow(/no runtime seeded it/);
  });
});
