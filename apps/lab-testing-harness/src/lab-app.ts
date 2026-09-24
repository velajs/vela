import {
  Catch,
  Controller,
  Get,
  Injectable,
  Inject,
  InjectionToken,
  Module,
  Param,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
} from '@velajs/vela';
import type {
  ArgumentMetadata,
  CallHandler,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
  OnModuleDestroy,
  OnModuleInit,
  PipeTransform,
} from '@velajs/vela';

export interface LabConfig {
  mode: string;
}

export const LAB_CONFIG = new InjectionToken<LabConfig>('LAB_CONFIG');
export const LIFECYCLE_LOG = new InjectionToken<string[]>('LIFECYCLE_LOG');

export class LabFailure extends Error {}

@Injectable()
export class ProbeClient {
  read() {
    return 'real-probe';
  }
}

@Injectable()
export class FakeProbeClient {
  read() {
    return 'fake-probe';
  }
}

@Injectable()
export class ReadingService {
  constructor(
    private readonly probe: ProbeClient,
    @Inject(LAB_CONFIG) private readonly config: LabConfig,
  ) {}

  list() {
    return [
      {
        id: 'reading-1',
        source: this.probe.read(),
        mode: this.config.mode,
      },
    ];
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return context.getRequest().headers.get('x-lab-key') === 'secret';
  }
}

@Injectable()
export class NormalizePipe implements PipeTransform {
  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    return String(value).toUpperCase();
  }
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
    return {
      wrappedBy: 'real-interceptor',
      data: await next.handle(),
    };
  }
}

@Catch(LabFailure)
export class LabErrorFilter implements ExceptionFilter {
  catch(exception: LabFailure, _context: ExecutionContext) {
    // An explicit { status, body } chooses the status; a plain value would
    // take the exception's (500 for this plain Error).
    return {
      status: 503,
      body: { handledBy: 'real-filter', message: exception.message },
    };
  }
}

@Injectable()
class LabLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(LIFECYCLE_LOG) private readonly log: string[]) {}

  onModuleInit() {
    this.log.push('init');
  }

  onModuleDestroy() {
    this.log.push('destroy');
  }
}

@Controller('/labs')
class LabController {
  constructor(private readonly readings: ReadingService) {}

  @Get('/readings')
  readingsList() {
    return this.readings.list();
  }

  @Get('/secure')
  @UseGuards(AuthGuard)
  secure() {
    return { ok: true };
  }

  @Get('/samples/:sample')
  @UsePipes(NormalizePipe)
  sample(@Param('sample') sample: string) {
    return { sample };
  }

  @Get('/enveloped')
  @UseInterceptors(EnvelopeInterceptor)
  enveloped() {
    return { value: 42 };
  }

  @Get('/failure')
  @UseFilters(LabErrorFilter)
  failure() {
    throw new LabFailure('calibration failed');
  }
}

@Module({
  providers: [
    ProbeClient,
    ReadingService,
    AuthGuard,
    NormalizePipe,
    EnvelopeInterceptor,
    LabErrorFilter,
    LabLifecycle,
    { provide: LAB_CONFIG, useValue: { mode: 'real' } },
    // Each compiled module records its own lifecycle.
    { provide: LIFECYCLE_LOG, useFactory: () => [] },
  ],
  controllers: [LabController],
})
export class LabModule {}
