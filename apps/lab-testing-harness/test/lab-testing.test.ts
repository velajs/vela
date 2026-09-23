import { describe, expect, it } from 'vitest';
import { Test, OverrideBy, TestingModule, TestingModuleBuilder } from '@velajs/testing';
import type {
  ArgumentMetadata,
  CallHandler,
  ExecutionContext,
  ExceptionFilter,
  NestInterceptor,
  PipeTransform,
} from '@velajs/vela';
import {
  AuthGuard,
  EnvelopeInterceptor,
  FakeProbeClient,
  LAB_CONFIG,
  LabErrorFilter,
  LabFailure,
  LabModule,
  LIFECYCLE_LOG,
  NormalizePipe,
  ProbeClient,
  ReadingService,
  type LabConfig,
} from '../src/lab-app.js';

describe('Lab testing harness consumer project', () => {
  it('compiles a real module and resolves providers with get()', async () => {
    const builder = Test.createTestingModule({
      imports: [LabModule],
    });
    expect(builder).toBeInstanceOf(TestingModuleBuilder);

    const moduleRef = await builder.compile();
    expect(moduleRef).toBeInstanceOf(TestingModule);

    const readings = moduleRef.get(ReadingService);
    expect(readings.list()).toEqual([{ id: 'reading-1', source: 'real-probe', mode: 'real' }]);
    const lifecycleLog = moduleRef.get(LIFECYCLE_LOG);
    expect(lifecycleLog).toEqual(['init']);

    await moduleRef.close('provider-test-complete');
    expect(lifecycleLog).toEqual(['init', 'destroy']);
  });

  it('overrides providers with useValue, useClass, and useFactory', async () => {
    const override = Test.createTestingModule({
      imports: [LabModule],
    }).overrideProvider(ProbeClient);
    expect(override).toBeInstanceOf(OverrideBy);

    const moduleRef = await override
      .useClass(FakeProbeClient)
      .overrideProvider(LAB_CONFIG)
      .useFactory({
        factory: () => ({ mode: 'factory' }) satisfies LabConfig,
      })
      .compile();

    const readings = moduleRef.get(ReadingService);
    expect(readings.list()).toEqual([{ id: 'reading-1', source: 'fake-probe', mode: 'factory' }]);

    await moduleRef.close('provider-overrides-complete');

    // The same module compiles again; the previous override does not carry over.
    const valueModule = await Test.createTestingModule({
      imports: [LabModule],
    })
      .overrideProvider(ProbeClient)
      .useValue({ read: () => 'value-probe' })
      .compile();

    expect(valueModule.get(ReadingService).list()).toEqual([
      { id: 'reading-1', source: 'value-probe', mode: 'real' },
    ]);

    await valueModule.close('value-override-complete');
  });

  it('creates an HTTP application for controller testing', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [LabModule],
    }).compile();
    const app = await moduleRef.createApplication();
    const hono = app.getHonoApp();

    const readings = await hono.request('/labs/readings');
    expect(readings.status).toBe(200);
    expect(await readings.json()).toEqual([
      { id: 'reading-1', source: 'real-probe', mode: 'real' },
    ]);

    const denied = await hono.request('/labs/secure');
    expect(denied.status).toBe(403);

    const allowed = await hono.request('/labs/secure', {
      headers: { 'x-lab-key': 'secret' },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true });

    await moduleRef.close('http-test-complete');
  });

  it('overrides guard, pipe, interceptor, and filter components in HTTP tests', async () => {
    class OverridePipe implements PipeTransform {
      transform(value: unknown, _metadata: ArgumentMetadata) {
        return `override:${String(value)}`;
      }
    }

    class OverrideInterceptor implements NestInterceptor {
      async intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
        return {
          wrappedBy: 'override-interceptor',
          data: await next.handle(),
        };
      }
    }

    class OverrideFilter implements ExceptionFilter {
      catch(exception: LabFailure, _context: ExecutionContext) {
        return {
          handledBy: 'override-filter',
          message: exception.message,
        };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [LabModule],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overridePipe(NormalizePipe)
      .useClass(OverridePipe)
      .overrideInterceptor(EnvelopeInterceptor)
      .useClass(OverrideInterceptor)
      .overrideFilter(LabErrorFilter)
      .useClass(OverrideFilter)
      .compile();

    const app = await moduleRef.createApplication();
    const hono = app.getHonoApp();

    const secure = await hono.request('/labs/secure');
    expect(secure.status).toBe(200);
    expect(await secure.json()).toEqual({ ok: true });

    const piped = await hono.request('/labs/samples/alpha');
    expect(piped.status).toBe(200);
    expect(await piped.json()).toEqual({ sample: 'override:alpha' });

    const enveloped = await hono.request('/labs/enveloped');
    expect(enveloped.status).toBe(200);
    expect(await enveloped.json()).toEqual({
      wrappedBy: 'override-interceptor',
      data: { value: 42 },
    });

    const filtered = await hono.request('/labs/failure');
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toEqual({
      handledBy: 'override-filter',
      message: 'calibration failed',
    });

    await moduleRef.close('component-overrides-complete');
  });
});
