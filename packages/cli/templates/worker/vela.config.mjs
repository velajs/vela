import { VelaFactory } from '@velajs/vela';
import { AppModule } from './dist/app.module.js';

// Run pnpm build first: Node loads the same metadata-emitting SWC output as Wrangler.
// If the app later reads ENV, supply local equivalents: VelaFactory.create(AppModule, { env }).
export default {
  rootModule: AppModule,
  createApp: () => VelaFactory.create(AppModule),
};
