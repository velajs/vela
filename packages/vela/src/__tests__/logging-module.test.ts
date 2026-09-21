/* oxlint-disable typescript/no-extraneous-class -- Decorated module markers are framework inputs. */
import { describe, expect, it } from 'vitest';
import { APP_LOGGER, LoggingModule } from '../logging/logging.module';
import { Controller, Get, Inject, Module } from '../index';
import { ApplicationLogger } from '../logging/application-logger';
import { VelaFactory } from '../factory';
import { Container } from '../container/container';
import { defineProvider, forwardRef } from '../container/types';
import type { LogRecord } from '../logging/log.types';

@Controller('/logs')
class LogController {
  constructor(@Inject(APP_LOGGER) private readonly logging: ApplicationLogger) {}
  @Get()
  read() {
    this.logging.createLogger('controller').log('hello');
    return { ok: true };
  }
}

@Module({ controllers: [LogController] })
class FeatureModule {}

describe('LoggingModule', () => {
  it('uses global-within-app typed provider ownership with independent application instances', async () => {
    const a: LogRecord[] = [];
    const b: LogRecord[] = [];
    const loggingA = LoggingModule.forRoot({
      sinks: [
        (r) => {
          a.push(r);
        },
      ],
    });
    const loggingB = LoggingModule.forRoot({
      sinks: [
        (r) => {
          b.push(r);
        },
      ],
    });
    @Module({ imports: [FeatureModule, loggingA] })
    class A {}
    @Module({ imports: [FeatureModule, loggingB] })
    class B {}
    const appA = await VelaFactory.create(A);
    const appB = await VelaFactory.create(B);
    try {
      const loggerA = appA.get(APP_LOGGER);
      const loggerB = appB.get(APP_LOGGER);
      expect(loggerA).not.toBe(loggerB);
      await Promise.all([
        appA.fetch(new Request('https://example.com/logs')),
        appB.fetch(new Request('https://example.com/logs')),
      ]);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      const external = loggerA.createLogger();
      await appA.close();
      external.log('after close');
      expect(a).toHaveLength(1);
      loggerB.createLogger().log('still open');
      expect(b).toHaveLength(2);
    } finally {
      await Promise.all([appA.close(), appB.close()]);
    }
  });

  it('resolves async logging options through the existing module/provider engine', async () => {
    const records: LogRecord[] = [];
    const logging = LoggingModule.forRootAsync({
      inject: [],
      useFactory: async () => ({
        sinks: [
          (r: LogRecord) => {
            records.push(r);
          },
        ],
      }),
    });
    @Module({ imports: [logging] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      app.get(APP_LOGGER).createLogger().log('async configured');
      expect(records).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
  it('preserves runtime-private logger receivers through the existing lazy DI proxy', () => {
    const records: LogRecord[] = [];
    class Consumer {
      constructor(@Inject(forwardRef(() => APP_LOGGER)) readonly logging: ApplicationLogger) {}
    }
    const container = new Container();
    container.register(Consumer);
    container.register(
      defineProvider(APP_LOGGER, {
        inject: [Consumer],
        useFactory: (consumer) => {
          void consumer;
          return new ApplicationLogger({
            sinks: [
              (r) => {
                records.push(r);
              },
            ],
          });
        },
      }),
    );
    container.resolve(APP_LOGGER);
    container.resolve(Consumer).logging.createLogger('proxy').log('works');
    expect(records[0]?.category).toBe('proxy');
  });
});
