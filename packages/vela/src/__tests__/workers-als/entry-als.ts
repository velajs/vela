import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  VelaFactory,
  getCurrentRequestContext,
} from '../../index';
import type { VelaApplication } from '../../application';

// A singleton service that reads the current request's context purely via the
// ambient accessor — the whole point of the opt-in ambient container. If ALS
// propagation works on workerd, each request sees its own context.
@Injectable()
class DeepService {
  requestId(): string {
    return getCurrentRequestContext().id;
  }
}

@Controller('/ambient')
class AmbientController {
  constructor(@Inject(DeepService) private readonly deep: DeepService) {}
  @Get()
  handle() {
    return { id: this.deep.requestId() };
  }
}

@Module({ providers: [DeepService], controllers: [AmbientController] })
class AmbientAppModule {}

let cached: VelaApplication | null = null;

async function getApp(): Promise<VelaApplication> {
  if (cached) return cached;
  cached = await VelaFactory.create(AmbientAppModule, { ambientContainer: true });
  return cached;
}

export default {
  async fetch(request: Request): Promise<Response> {
    return (await getApp()).fetch(request);
  },
} satisfies ExportedHandler;

declare global {
  interface ExportedHandler<Env = unknown> {
    fetch?(request: Request, env: Env, ctx: unknown): Response | Promise<Response>;
  }
}
