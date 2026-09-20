import type { Context } from 'hono';
import { z } from 'zod';
import {
  Body,
  Container,
  Controller,
  ForwardRef,
  Get,
  Global,
  Injectable,
  Inject,
  InjectionToken,
  Logger,
  LogLevel,
  MetadataRegistry,
  Module,
  ModuleRef,
  Param,
  Post,
  Req,
  UseGuards,
  VelaFactory,
  ZodValidationPipe,
  env,
  forwardRef,
  getRuntimeKey,
  mixin,
} from '@velajs/vela';
import type {
  CanActivate,
  ExecutionContext,
  Type,
  VelaApplication,
} from '@velajs/vela';
import { streamText } from '@velajs/vela/streaming';

interface DiPlaygroundFixture {
  app: VelaApplication;
}

interface ProbeInput {
  name: string;
  count: number;
}

const ProbeSchema = z.object({
  name: z.string().min(1),
  count: z.number().int().positive(),
});

function roleGuard(role: string): Type<CanActivate> {
  class RoleGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      return context.getRequest().headers.get('x-role') === role;
    }
  }
  return mixin(RoleGuard);
}

export async function createDiPlaygroundApp(): Promise<DiPlaygroundFixture> {
  MetadataRegistry.clear();

  const TOKEN_A = new InjectionToken<string>('TOKEN_A');
  const TOKEN_B = new InjectionToken<string>('TOKEN_B');
  const manualForwardRef = new ForwardRef(() => TOKEN_A);

  @Injectable()
  class GlobalGreeting {
    message() {
      return 'global-ready';
    }
  }

  @Global()
  @Module({
    providers: [GlobalGreeting],
    exports: [GlobalGreeting],
  })
  class GlobalGreetingModule {}

  @Injectable()
  class DynamicAuditService {
    audit() {
      return 'dynamic-audit-ready';
    }
  }

  class DynamicAuditModuleClass {}

  const DynamicAuditModule = {
    module: DynamicAuditModuleClass,
    providers: [DynamicAuditService],
    exports: [DynamicAuditService],
  };

  let alphaSeen: AlphaService | undefined;

  @Injectable()
  class BetaService {
    constructor(@Inject(forwardRef(() => AlphaService)) private readonly alpha: unknown) {}

    name() {
      return 'beta';
    }

    peer() {
      return this.alpha ? 'alpha-linked' : 'alpha-missing';
    }
  }

  @Injectable()
  class AlphaService {
    constructor(@Inject(forwardRef(() => BetaService)) private readonly beta: BetaService) {
      alphaSeen = this;
    }

    report() {
      return `alpha:${this.beta.name()}:${this.beta.peer()}`;
    }
  }

  let ModuleARef: Type;

  @Module({
    imports: [forwardRef(() => ModuleARef)],
    providers: [{ provide: TOKEN_B, useValue: 'from-module-b' }],
    exports: [TOKEN_B],
  })
  class ModuleB {}

  @Module({
    imports: [ModuleB],
    providers: [{ provide: TOKEN_A, useValue: 'from-module-a' }],
    exports: [TOKEN_A],
  })
  class ModuleA {}

  ModuleARef = ModuleA;

  @Injectable()
  class CircularModuleSummary {
    constructor(
      @Inject(TOKEN_A) private readonly a: string,
      @Inject(TOKEN_B) private readonly b: string,
    ) {}

    values() {
      return { a: this.a, b: this.b };
    }
  }

  @Injectable()
  class CounterService {
    private count = 0;

    increment() {
      return ++this.count;
    }
  }

  @Injectable()
  class SandboxTool {
    ping() {
      return 'sandbox-tool-ready';
    }
  }

  const AdminGuard = roleGuard('admin');
  const MaintainerGuard = roleGuard('maintainer');

  @Controller('/playground')
  class PlaygroundController {
    constructor(
      private readonly globalGreeting: GlobalGreeting,
      private readonly audit: DynamicAuditService,
      private readonly alpha: AlphaService,
      private readonly circularModules: CircularModuleSummary,
      private readonly moduleRef: ModuleRef,
      private readonly counter: CounterService,
    ) {}

    @Get('/global')
    global() {
      return { message: this.globalGreeting.message() };
    }

    @Get('/dynamic')
    dynamic() {
      return { audit: this.audit.audit() };
    }

    @Get('/forward-ref')
    forwardRefReport() {
      return {
        provider: this.alpha.report(),
        module: this.circularModules.values(),
        manual: manualForwardRef.factory() === TOKEN_A,
      };
    }

    @Get('/module-ref')
    moduleRefReport() {
      const first = this.moduleRef.get(CounterService);
      first.increment();
      const second = this.moduleRef.resolve(CounterService);
      second.increment();
      const fresh = this.moduleRef.create(CounterService);

      return {
        singletonCount: second.increment(),
        sameSingleton: first === this.counter,
        freshCount: fresh.increment(),
        freshIsSingleton: fresh === this.counter,
      };
    }

    @Get('/container')
    containerReport() {
      const container = new Container();
      container.register(SandboxTool);
      return {
        ping: container.resolve(SandboxTool).ping(),
      };
    }

    @Get('/mixin/admin')
    @UseGuards(AdminGuard)
    admin() {
      return { role: 'admin' };
    }

    @Get('/mixin/maintainer')
    @UseGuards(MaintainerGuard)
    maintainer() {
      return { role: 'maintainer' };
    }

    @Post('/zod')
    zod(@Body(new ZodValidationPipe(ProbeSchema)) body: ProbeInput) {
      return { parsed: body };
    }

    @Get('/runtime')
    runtime(@Req() c: Context) {
      const runtimeEnv = env<Record<string, unknown>>(c);
      return {
        runtime: getRuntimeKey(),
        hasEnvironment: typeof runtimeEnv === 'object' && runtimeEnv !== null,
      };
    }

    @Get('/logger')
    logger() {
      const lines: string[] = [];
      const logger = new Logger('DiPlayground')
        .addContextProvider(() => ({ feature: 'logger' }))
        .setWriter((level, line) => {
          lines.push(`${level}:${line}`);
        });

      logger.log('diagnostic-ready');

      return {
        logLevel: LogLevel.LOG,
        captured: lines.length,
        hasContext: lines[0]?.includes('feature=logger') ?? false,
      };
    }

    @Get('/stream')
    stream(@Req() c: Context) {
      return streamText(c, async (stream) => {
        await stream.write('alpha\n');
        await stream.write('omega\n');
      });
    }

    @Get('/param/:name')
    param(@Param('name') name: string) {
      return { name };
    }
  }

  @Module({
    imports: [GlobalGreetingModule, DynamicAuditModule, ModuleA, ModuleB],
    providers: [AlphaService, BetaService, CircularModuleSummary, CounterService],
    controllers: [PlaygroundController],
  })
  class DiPlaygroundModule {}

  const app = await VelaFactory.create(DiPlaygroundModule, {
    globalPrefix: '/api',
  });

  return { app };
}
