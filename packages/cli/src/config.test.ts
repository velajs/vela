import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineVelaConfig, loadConfig, resolveConfig } from './config.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(source: string, name = 'vela.config.mjs') {
  const cwd = await mkdtemp(join(tmpdir(), 'vela-config-'));
  directories.push(cwd);
  await writeFile(join(cwd, name), source);
  return cwd;
}

describe('configuration boundary', () => {
  it('records actual candidate precedence without importing config code', async () => {
    const cwd = await fixture(`throw new Error('must not import');`);
    const mjs = join(cwd, 'vela.config.mjs');
    expect(await resolveConfig(cwd)).toEqual({
      path: mjs,
      source: 'discovered',
      candidates: [join(cwd, 'vela.config.js'), mjs],
    });
    await writeFile(join(cwd, 'vela.config.js'), `throw new Error('also not imported');`);
    expect((await resolveConfig(cwd)).path).toBe(join(cwd, 'vela.config.js'));
    expect(await resolveConfig(cwd, 'vela.config.mjs')).toEqual({
      path: mjs,
      source: 'explicit',
      candidates: [mjs],
    });
    expect(await resolveConfig(cwd, mjs)).toEqual({
      path: mjs,
      source: 'explicit',
      candidates: [mjs],
    });
  });

  it('does not infer config from a parent or silently fall back from an explicit path', async () => {
    const cwd = await fixture(`export default { createApp() {} };`);
    await mkdir(join(cwd, 'nested'));
    await expect(resolveConfig(join(cwd, 'nested'))).rejects.toThrow('No vela config');
    await expect(resolveConfig(cwd, 'missing.mjs')).rejects.toThrow('missing.mjs');
    await expect(resolveConfig(cwd, '')).rejects.toThrow('--config');
  });

  it('keeps the original config and its method receiver', async () => {
    const cwd = await fixture(
      `export default { marker: 'receiver', createApp() { return this.marker; } };`,
    );
    const config = await loadConfig(cwd);
    expect(config.createApp()).toBe('receiver');
    expect(defineVelaConfig(config)).toBe(config);
  });

  it('supports named exports and gives default exports precedence', async () => {
    const named = await fixture(`export const config = { createApp() {} };`);
    expect(typeof (await loadConfig(named)).createApp).toBe('function');
    const invalidDefault = await fixture(
      `export default false; export const config = { createApp() {} };`,
    );
    await expect(loadConfig(invalidDefault)).rejects.toThrow('createApp');
  });

  it.each([
    'null',
    '42',
    '[]',
    '{}',
    '{ createApp: 1 }',
    '{ createApp: async () => {}, rootModule: 1 }',
    '{ createApp() {}, rootModule: () => {} }',
  ])('rejects an invalid imported config: %s', async (value) => {
    const cwd = await fixture(`export default ${value};`);
    await expect(loadConfig(cwd)).rejects.toThrow(/Config at/);
  });

  it('checks the root constructor without constructing it', async () => {
    const cwd = await fixture(
      `export default { createApp() {}, rootModule: class Root { constructor() { throw Error('do not construct'); } } };`,
    );
    expect((await loadConfig(cwd)).rootModule?.name).toBe('Root');
  });

  it('reports a config that fails to load with the Vite runner that loaded it', async () => {
    const cwd = await fixture(`import './src/missing.js'; export default { createApp() {} };`);
    const error = await loadConfig(cwd).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(`Could not import config at ${join(cwd, 'vela.config.mjs')}`);
    expect(String(error)).toContain("Vite's module runner");
    expect(error).toHaveProperty('cause');
  });

  it('loads TypeScript configs through Vite with legacy decorators and constructor metadata', async () => {
    // A stand-in for the Reflect metadata polyfill Vela installs, restored after
    // the class is decorated so no other test sees it.
    const cwd = await fixture(
      `
      const recorded: [string, string[]][] = [];
      const reflect: { metadata?: unknown } = Reflect;
      const previous = reflect.metadata;
      reflect.metadata = (key: string, value: unknown) => () => {
        if (Array.isArray(value)) recorded.push([key, value.map((type) => type.name)]);
      };
      function Decorated(_target: object): void {}
      export class Dependency {}
      @Decorated
      class Root {
        constructor(readonly dependency: Dependency) {}
      }
      if (previous === undefined) delete reflect.metadata;
      else reflect.metadata = previous;
      export default { rootModule: Root, createApp: () => recorded };
      `,
      'vela.config.ts',
    );
    const config = await loadConfig(cwd);
    expect(config.rootModule?.name).toBe('Root');
    expect(config.createApp()).toEqual([['design:paramtypes', ['Dependency']]]);
  });

  it('rejects a config directory instead of attempting to import it', async () => {
    const cwd = await fixture('export default { createApp() {} };');
    await mkdir(join(cwd, 'directory.mjs'));
    await expect(loadConfig(cwd, 'directory.mjs')).rejects.toThrow(/file/);
  });
});
