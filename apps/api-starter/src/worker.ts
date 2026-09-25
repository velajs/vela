import { defineCloudflareApp } from '@velajs/cloudflare';
import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';
import { AppModule } from './app';

// One app definition: the Worker and the LiveRoom Durable Object share its
// root module and options.
const app = defineCloudflareApp(AppModule);

export class LiveRoom extends VelaWebSocketDurableObject(app) {}
export default app.worker;
