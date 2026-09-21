import { createCloudflareWorker } from '@velajs/cloudflare';
import { moduleToken } from '@velajs/vela';
import type { Env } from './app.js';
import { createAppModule } from './app.js';

export default createCloudflareWorker(
  { create: createAppModule },
  { envToken: moduleToken<Env>('multi-database:env') },
);
