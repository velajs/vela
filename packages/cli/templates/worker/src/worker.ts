import { createCloudflareWorker } from '@velajs/cloudflare';
import { InjectionToken } from '@velajs/vela';
import { AppModule } from './app.module.js';

const ENV = new InjectionToken<Record<string, never>>('Worker environment');

export default createCloudflareWorker(AppModule, { envToken: ENV });
