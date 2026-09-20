import { Controller, Get, Module, VelaFactory, type VelaApplication } from '@velajs/vela';

@Controller()
class ReferenceController {
  @Get()
  index() {
    return { ok: true };
  }
}

@Module({ controllers: [ReferenceController] })
class ReferenceModule {}

let application: Promise<VelaApplication> | undefined;

function getApplication(): Promise<VelaApplication> {
  application ??= VelaFactory.create(ReferenceModule);
  return application;
}

export default {
  async fetch(request: Request): Promise<Response> {
    return (await getApplication()).fetch(request);
  },
};
