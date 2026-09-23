import { defineVelaConfig } from '@velajs/cli/config';
import { VelaFactory } from '@velajs/vela';
import { AppModule } from './src/app.module.js';

// `pnpm vela ...` loads this file and the decorated sources it imports through
// Vite, with the same Oxc decorator metadata as the Worker build: no build step.
// If the app later reads ENV, supply local equivalents: VelaFactory.create(AppModule, { env }).
export default defineVelaConfig({
  rootModule: AppModule,
  createApp: () => VelaFactory.create(AppModule),
});
