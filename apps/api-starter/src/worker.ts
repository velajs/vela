import { createCloudflareWorker } from "@velajs/cloudflare";
import { VelaWebSocketDurableObject } from "@velajs/cloudflare/durable-objects";
import { createAppModule } from "./app";
import { ENV } from "./env";

const root = { create: createAppModule };
export class LiveRoom extends VelaWebSocketDurableObject(root, { envToken: ENV }) {}
export default createCloudflareWorker(root, { envToken: ENV });
