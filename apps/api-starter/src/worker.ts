import { createCloudflareWorker } from '@velajs/cloudflare';
import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';
import { AppModule } from './app';

export class LiveRoom extends VelaWebSocketDurableObject(AppModule) {}
export default createCloudflareWorker(AppModule);
