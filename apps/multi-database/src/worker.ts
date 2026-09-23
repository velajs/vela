import { createCloudflareWorker } from '@velajs/cloudflare';
import { createAppModule } from './app.js';

export default createCloudflareWorker({ create: createAppModule });
