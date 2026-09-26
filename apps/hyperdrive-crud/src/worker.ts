import { createCloudflareWorker } from '@velajs/cloudflare';
import { AppModule } from './app.js';
const worker = createCloudflareWorker(AppModule);
export default {
  async fetch(request, env, ctx) {
    // This example only serves an explicitly authorized synthetic database.
    if (!env.ACCESS_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.ACCESS_TOKEN}`)
      return new Response('Unauthorized', { status: 401 });
    return worker.fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
