import { createCloudflareWorker } from '@velajs/cloudflare';
import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';
import { createAppModule } from './app';

const root = { create: createAppModule };
export class LiveRoom extends VelaWebSocketDurableObject(root) {}
export default createCloudflareWorker(root);
