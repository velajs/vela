import { defineCloudflareApp } from '@velajs/cloudflare';
import { VelaDurableObject } from '@velajs/cloudflare/durable-objects';
import { VelaEntrypoint } from '@velajs/cloudflare/entrypoints';
import { VelaWorkflow } from '@velajs/cloudflare/workflows';
import { WorkerBindingsLabModule } from './app.js';
import { CounterHost } from './counter.host.js';
import { QuotesHost } from './quotes.host.js';
import { SignupHost } from './signup.host.js';

// One app definition: the Worker and the classes defined from it share its
// root module. Each Counter instance boots its own application context, with
// the CounterHost methods rpc names as its RPC methods. Signup runs and Quotes
// calls execute in the Worker's own application.
const app = defineCloudflareApp(WorkerBindingsLabModule);

export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['status'] }) {}

export class Signup extends VelaWorkflow(app, SignupHost) {}

export class Quotes extends VelaEntrypoint(app, QuotesHost, { rpc: ['quote'] }) {}

export default app.worker;
