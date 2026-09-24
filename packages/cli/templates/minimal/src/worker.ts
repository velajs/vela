import { createCloudflareWorker } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';

export default createCloudflareWorker(AppModule);
