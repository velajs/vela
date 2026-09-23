import { Controller, Get, Module } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';

@Controller()
class ReferenceController {
  @Get()
  index() {
    return { ok: true };
  }
}

@Module({ controllers: [ReferenceController] })
class ReferenceModule {}

export default createCloudflareWorker(ReferenceModule);
