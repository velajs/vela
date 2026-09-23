import { Module } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { StudioModule } from '../../src';

// No token in module options: Studio must take VELA_STUDIO_TOKEN from the
// Worker environment the Cloudflare runtime seeds as ENV.
class App {}
Module({ imports: [StudioModule.forRoot({})] })(App);

export default createCloudflareWorker(App);
