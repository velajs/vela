import { describe, expect, it } from 'vitest';
// Deliberately not a barrel: this suite checks what the scheduled-job seam
// loads on its own, as a runtime adapter imports it for every Worker.
import { getRootDefaults } from '../container/root-defaults';
import { describeToken } from '../container/types';
import { invokeScheduledJob } from '../schedule/schedule.invoke';

const SIGNED_DISPATCH_SERVICES = ['InternalDispatcher', 'UrlGeneratorService'];

function declaredServices(): string[] {
  return [...getRootDefaults().keys()].map(describeToken);
}

describe('scheduled-job dispatch seam', () => {
  it('leaves the signed-dispatch services to ScheduleModule, which configures signed dispatch', async () => {
    expect(invokeScheduledJob).toBeTypeOf('function');
    expect(declaredServices().filter((name) => SIGNED_DISPATCH_SERVICES.includes(name))).toEqual(
      [],
    );

    await import('../schedule/schedule.module');
    expect(declaredServices()).toEqual(expect.arrayContaining(SIGNED_DISPATCH_SERVICES));
  });
});
