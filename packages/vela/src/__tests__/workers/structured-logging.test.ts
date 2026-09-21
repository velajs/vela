import { describe, expect, it } from 'vitest';
import { ApplicationLogger } from '../../logging/application-logger';
import { Container } from '../../container/container';
import { defineProvider } from '../../container/types';
import { runInEntrypointScope } from '../../entrypoint/execution-scope';
import { APP_LOGGER } from '../../logging/logging.module';
import { resolveErrorReporter } from '../../exceptions/reporter';
import type { LogRecord } from '../../logging/log.types';

describe('structured logging under workerd', () => {
  it('isolates concurrent invocation contexts, redacts and drains async sinks without Node APIs', async () => {
    const records: LogRecord[] = [];
    const pending: Promise<void>[] = [];
    const logging = new ApplicationLogger({
      sinks: [
        async (record) => {
          await Promise.resolve();
          records.push(record);
        },
      ],
    });
    await Promise.all(
      ['a', 'b'].map(async (id) => {
        const logger = logging.createLogger(
          'worker',
          { token: 'hidden' },
          {
            fields: { invocationId: id },
            waitUntil: (task) => {
              pending.push(task);
            },
          },
        );
        await Promise.resolve();
        logger.error(new Error('failed', { cause: { password: 'hidden', total: 2n } }));
      }),
    );
    await Promise.all(pending);
    await logging.flush();
    expect(records.map((r) => r.fields.invocationId).toSorted()).toEqual(['a', 'b']);
    expect(JSON.stringify(records)).not.toContain('hidden');
    expect(Object.keys(logging)).toEqual([]);
    await logging.dispose();
  });
  it('correlates default exception reporting and drains managed delivery in the native runtime', async () => {
    const records: LogRecord[] = [];
    const logging = new ApplicationLogger({
      sinks: [
        async (record) => {
          await Promise.resolve();
          records.push(record);
        },
      ],
    });
    const container = new Container();
    container.register(defineProvider(APP_LOGGER, { useValue: logging }));
    let invocationId = '';
    await runInEntrypointScope(container, (scope, lifetime) => {
      invocationId = lifetime.id;
      resolveErrorReporter(scope).report(Object.assign(new Error('failed'), { token: 'hidden' }), {
        edge: 'queue',
        source: 'Worker.process',
      });
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.fields.invocationId).toBe(invocationId);
    expect(records[0]?.fields.source).toBe('Worker.process');
    expect(JSON.stringify(records)).not.toContain('hidden');
    await logging.dispose();
  });
});
