import { createCloudflareWorker } from '@velajs/cloudflare';
import { AppModule } from './app.js';

export default createCloudflareWorker(AppModule);
