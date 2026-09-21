import { PassThrough } from 'node:stream';
import { Injectable, Module, VelaFactory } from '@velajs/vela';
import { Seeder, SeederModule } from '@velajs/vela/seeder';
import { Cli } from 'clipanion';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { SeedCommand } from './seed.command.js';

vi.mock('../config.js', () => ({ loadConfig: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

async function run(args: string[] = []) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = '';
  stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const code = await Cli.from([SeedCommand]).run(['db', 'seed', ...args], { stdout, stderr });
  return { code, output };
}

describe('seeder application lifetime', () => {
  it('disposes the app when the seeder registry is missing', async () => {
    @Module({})
    class Root {}
    const app = await VelaFactory.create(Root);
    const dispose = vi.spyOn(app, 'dispose');
    vi.mocked(loadConfig).mockResolvedValue({ createApp: () => app });
    expect((await run()).code).toBe(1);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('preserves seeder failures and continue-on-error while disposing once', async () => {
    const calls: string[] = [];
    @Seeder({ order: 0 })
    @Injectable()
    class Failing {
      run() {
        calls.push('fail');
        throw new Error('seed failed');
      }
    }
    @Seeder({ order: 1 })
    @Injectable()
    class Next {
      run() {
        calls.push('next');
      }
    }
    @Module({ imports: [SeederModule.forRoot({ seeders: [Failing, Next] })] })
    class Root {}
    for (const args of [[], ['--continue-on-error']]) {
      calls.length = 0;
      const app = await VelaFactory.create(Root);
      const dispose = vi.spyOn(app, 'dispose');
      vi.mocked(loadConfig).mockResolvedValue({ createApp: () => app });
      expect((await run(args)).code).toBe(1);
      expect(calls).toEqual(args.length ? ['fail', 'next'] : ['fail']);
      expect(dispose).toHaveBeenCalledOnce();
    }
  });
});
