import { defineCloudflareApp } from '@velajs/cloudflare';
import { VelaDurableObject } from '@velajs/cloudflare/durable-objects';
import { WorkerBindingsLabModule } from './app.js';
import { CounterHost } from './counter.host.js';

// One app definition: the Worker and the Counter Durable Object share its root
// module. Each Counter instance boots its own application context, with
// CounterHost's public methods as its RPC methods.
const app = defineCloudflareApp(WorkerBindingsLabModule);

export class Counter extends VelaDurableObject(app, CounterHost) {}

export default app.worker;
