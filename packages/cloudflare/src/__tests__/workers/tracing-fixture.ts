import { tracing } from 'cloudflare:workers';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  InjectEnv,
  Module,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type VelaEnv,
} from '@velajs/vela';
import { CloudflareTracingInterceptor } from '../../tracing';

@Injectable()
class NativeChildInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
    return tracing.enterSpan('fixture.interceptor', () => next.handle());
  }
}

@Injectable()
class TracingWork {
  constructor(@InjectEnv() private readonly env: VelaEnv) {}

  read() {
    return tracing.enterSpan('fixture.read', async (outer) => {
      const before: unknown = Reflect.get(this.env, 'TRACING_PROBE') ?? this.env.ENV_PROBE;
      await this.env.CACHE.get('tracing-probe');
      return tracing.enterSpan('fixture.after-await', async (inner) => {
        await this.env.CACHE.get('tracing-probe');
        const after: unknown = Reflect.get(this.env, 'TRACING_PROBE') ?? this.env.ENV_PROBE;
        return { before, after, outerTraced: outer.isTraced, innerTraced: inner.isTraced };
      });
    });
  }

  fail(): Promise<never> {
    return tracing.enterSpan('fixture.failure', async () => {
      await this.env.CACHE.get('tracing-probe');
      throw new Error('private tracing failure');
    });
  }
}

@Controller('/tracing')
@UseInterceptors(CloudflareTracingInterceptor, NativeChildInterceptor)
class TracingController {
  constructor(
    @Inject(TracingWork) private readonly work: TracingWork,
    @InjectEnv() private readonly env: VelaEnv,
  ) {}

  @Get()
  read() {
    return this.work.read();
  }

  @Get('rpc')
  rpc() {
    return this.env.TRACING_RPC.read();
  }

  @Get('fail')
  fail() {
    return this.work.fail();
  }
}

@Injectable()
@UseInterceptors(CloudflareTracingInterceptor, NativeChildInterceptor)
export class TracingHost {
  constructor(@Inject(TracingWork) private readonly work: TracingWork) {}

  read() {
    return this.work.read();
  }

  fail() {
    return this.work.fail();
  }
}

@Module({ controllers: [TracingController], providers: [TracingWork], exports: [TracingWork] })
export class TracingModule {}
