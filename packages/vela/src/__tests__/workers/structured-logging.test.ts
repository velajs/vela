import { describe, expect, it } from 'vitest';
import { ApplicationLogger } from '../../logging/application-logger';
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
});
