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
import { defineLabTestingFixture, type LabConfig, LabFailure } from '../src/lab-app.js';

describe('Lab testing harness consumer project', () => {
  it('compiles a real module and resolves providers with get()', async () => {
    const fixture = defineLabTestingFixture();

    const builder = Test.createTestingModule({
      imports: [fixture.LabModule],
    });
    expect(builder).toBeInstanceOf(TestingModuleBuilder);

    const moduleRef = await builder.compile();
    expect(moduleRef).toBeInstanceOf(TestingModule);

    const readings = moduleRef.get(fixture.ReadingService);
    expect(readings.list()).toEqual([{ id: 'reading-1', source: 'real-probe', mode: 'real' }]);
    expect(fixture.lifecycleLog).toEqual(['init']);

    await moduleRef.close('provider-test-complete');
    expect(fixture.lifecycleLog).toEqual(['init', 'destroy']);
  });

  it('overrides providers with useValue, useClass, and useFactory', async () => {
    const fixture = defineLabTestingFixture();

    const override = Test.createTestingModule({
      imports: [fixture.LabModule],
    }).overrideProvider(fixture.ProbeClient);
    expect(override).toBeInstanceOf(OverrideBy);

    const moduleRef = await override
      .useClass(fixture.FakeProbeClient)
      .overrideProvider(fixture.LAB_CONFIG)
      .useFactory({
        factory: () => ({ mode: 'factory' }) satisfies LabConfig,
      })
      .compile();

    const readings = moduleRef.get(fixture.ReadingService);
    expect(readings.list()).toEqual([{ id: 'reading-1', source: 'fake-probe', mode: 'factory' }]);

    await moduleRef.close('provider-overrides-complete');

    const fixtureWithValue = defineLabTestingFixture();
    const valueModule = await Test.createTestingModule({
      imports: [fixtureWithValue.LabModule],
    })
      .overrideProvider(fixtureWithValue.ProbeClient)
      .useValue({ read: () => 'value-probe' })
      .compile();

    expect(valueModule.get(fixtureWithValue.ReadingService).list()).toEqual([
      { id: 'reading-1', source: 'value-probe', mode: 'real' },
    ]);

    await valueModule.close('value-override-complete');
  });

  it('creates an HTTP application for controller testing', async () => {
    const fixture = defineLabTestingFixture();
    const moduleRef = await Test.createTestingModule({
      imports: [fixture.LabModule],
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
    const fixture = defineLabTestingFixture();

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
      imports: [fixture.LabModule],
    })
      .overrideGuard(fixture.AuthGuard)
      .useValue({ canActivate: () => true })
      .overridePipe(fixture.NormalizePipe)
      .useClass(OverridePipe)
      .overrideInterceptor(fixture.EnvelopeInterceptor)
      .useClass(OverrideInterceptor)
      .overrideFilter(fixture.LabErrorFilter)
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
