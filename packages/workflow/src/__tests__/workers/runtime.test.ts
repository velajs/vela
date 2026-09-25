// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as test from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { workflowEventStream } from '../../cloudflare/index';

interface Introspector {
  waitForStatus(status: string): Promise<void>;
  waitForStepResult(step: { name: string }): Promise<unknown>;
  getOutput(): Promise<unknown>;
  dispose(): Promise<void>;
}
const pool: { introspectWorkflowInstance(binding: Workflow, id: string): Promise<Introspector> } =
  test;

async function events(instance: WorkflowInstance) {
  const stream = await workflowEventStream({ instance, authorize: () => {} });
  const reader = stream.getReader();
  const result: WorkflowInstanceEvent[] = [];
  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- Consume a native subscription sequentially.
      const next = await reader.read();
      if (next.done) return result;
      result.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

it('validates ingress, retries natively and resumes without repeating completed steps', async () => {
  const id = crypto.randomUUID();
  const inspector = await pool.introspectWorkflowInstance(env.BRIDGE, id);
  try {
    const instance = await env.BRIDGE.create({ id, params: { mode: 'resume', count: '7' } });
    const first = await inspector.waitForStepResult({ name: 'first' });
    await instance.pause();
    await inspector.waitForStatus('paused');
    await instance.resume();
    await instance.sendEvent({ type: 'approved', payload: { accepted: true } });
    await inspector.waitForStatus('complete');
    expect(await inspector.getOutput()).toEqual({ first, accepted: true, dispatched: 'native' });
    expect(first).toMatchObject({ attempt: 2, count: 7, label: 'native' });
    const history = await events(instance);
    expect(
      history.filter((event) => event.type === 'step_completed' && event.stepName === 'first-1'),
    ).toHaveLength(1);
    expect(
      history.filter((event) => event.type === 'attempt_started' && event.stepName === 'first-1'),
    ).toHaveLength(2);
    await instance.delete();
  } finally {
    await inspector.dispose();
  }
});

it.each(['fatal', 'runStep', 'rollback', 'invalid'] as const)(
  'does not retry terminal %s failures',
  async (mode) => {
    const id = crypto.randomUUID();
    const inspector = await pool.introspectWorkflowInstance(env.BRIDGE, id);
    try {
      const instance = await env.BRIDGE.create({ id, params: { mode, count: '7' } });
      await inspector.waitForStatus('errored');
      const history = await events(instance);
      const attempts = history.filter((event) => event.type === 'attempt_started');
      expect(attempts).toHaveLength(mode === 'invalid' ? 0 : 1);
      if (mode === 'fatal') {
        const failure = history.find((event) => event.type === 'attempt_errored');
        expect(failure).toMatchObject({
          error: { message: expect.stringContaining('PolicyDenied') },
        });
      }
      if (mode === 'rollback')
        expect(history.filter((event) => event.type === 'rollback_attempt_started')).toHaveLength(
          1,
        );
      const deleted = await env.BRIDGE.deleteBatch([id]);
      expect(deleted.deleted).toEqual([{ id }]);
    } finally {
      await inspector.dispose();
    }
  },
);
