import type { VelaApplication } from '@velajs/vela';
import { defineVelaConfig } from './config.js';

// Checked by the package's tsc gate; never imported by the CLI.
export function configTypes(app: VelaApplication & { label: 'custom' }) {
  class Root {
    readonly root = true;
  }
  const config = defineVelaConfig({
    rootModule: Root,
    profile: 'local',
    createApp: () => app,
  });
  const exactApp: typeof app = config.createApp();
  const profile: 'local' = config.profile;
  const root: Root = new config.rootModule();
  const asyncConfig = defineVelaConfig({ createApp: async () => app });
  const exactPromise: Promise<typeof app> = asyncConfig.createApp();
  // @ts-expect-error a config must create an application
  defineVelaConfig({ createApp: () => ({ label: 'invalid' }) });
  // @ts-expect-error rootModule must be constructable
  defineVelaConfig({ createApp: () => app, rootModule: () => ({}) });
  return { exactApp, profile, root, exactPromise };
}
