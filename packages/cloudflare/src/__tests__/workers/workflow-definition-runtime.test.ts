// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as cloudflareTest from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { AGENT_APPROVAL_EVENT_TYPE } from '@velajs/agent';

interface Introspector {
  modify(
    fn: (modifier: {
      disableSleeps(): Promise<void>;
      disableRetryDelays(): Promise<void>;
    }) => Promise<void>,
  ): Promise<Introspector>;
  waitForStepResult(step: { name: string }): Promise<unknown>;
  waitForStatus(status: InstanceStatus['status']): Promise<void>;
  getOutput(): Promise<unknown>;
  getError(): Promise<{ name: string; message: string }>;
  dispose(): Promise<void>;
}
const pool: { introspectWorkflowInstance(workflow: Workflow, id: string): Promise<Introspector> } =
  cloudflareTest;

async function inspect(
  workflow: Workflow,
  id: string,
  test: (instance: Introspector) => Promise<void>,
) {
  const instance = await pool.introspectWorkflowInstance(workflow, id);
  try {
    await instance.modify(async (modifier) => {
      await modifier.disableSleeps();
      await modifier.disableRetryDelays();
    });
    await test(instance);
  } finally {
    await instance.dispose();
  }
}

describe('portable workflow definitions under workerd', () => {
  it('types input transforms and runs native retries, scoped DI and signed dispatch', async () => {
    expectTypeOf<Parameters<typeof env.PORTABLE_WORKFLOW.create>[0]>().toMatchTypeOf<
      | WorkflowInstanceCreateOptions<
          Readonly<{ value: string; mode?: 'plain' | 'retry' | 'terminal' | 'rollback' }>
        >
      | undefined
    >();
    const before = await env.PORTABLE_PROBE.snapshot();
    await inspect(env.PORTABLE_WORKFLOW, 'portable-retry', async (instance) => {
      await env.PORTABLE_WORKFLOW.create({
        id: 'portable-retry',
        params: { value: '7', mode: 'retry' },
      });
      await instance.waitForStatus('complete');
      expect(await instance.getOutput()).toMatchObject({
        value: 14,
        run: expect.any(String),
        region: 'workerd-env',
      });
    });
    const after = await env.PORTABLE_PROBE.snapshot();
    expect(after.attempts['portable-retry']).toBe(2);
    expect(after.dispatches).toBe(before.dispatches + 1);
    expect(after.disposed.length).toBeGreaterThan(before.disposed.length);
  });

  it('fails validation before invoking factories and treats callback terminal errors as nonretryable', async () => {
    const before = await env.PORTABLE_PROBE.snapshot();
    await inspect(env.PORTABLE_WORKFLOW, 'portable-invalid', async (instance) => {
      await env.PORTABLE_WORKFLOW.create({ id: 'portable-invalid', params: { value: 'invalid' } });
      await instance.waitForStatus('errored');
      expect((await instance.getError()).message).toContain('NonRetryableError');
    });
    expect((await env.PORTABLE_PROBE.snapshot()).factories).toBe(before.factories);
    await inspect(env.PORTABLE_WORKFLOW, 'portable-terminal', async (instance) => {
      await env.PORTABLE_WORKFLOW.create({
        id: 'portable-terminal',
        params: { value: '1', mode: 'terminal' },
      });
      await instance.waitForStatus('errored');
    });
    expect((await env.PORTABLE_PROBE.snapshot()).attempts['portable-terminal']).toBe(1);
  });

  it('runs native compensation without retrying portable terminal rollback errors', async () => {
    await inspect(env.PORTABLE_WORKFLOW, 'portable-rollback', async (instance) => {
      await env.PORTABLE_WORKFLOW.create({
        id: 'portable-rollback',
        params: { value: '1', mode: 'rollback' },
      });
      await instance.waitForStatus('errored');
    });
    expect((await env.PORTABLE_PROBE.snapshot()).rollbacks['portable-rollback']).toBe(1);
  });

  it('parks a compiled agent for approval, resumes it and deduplicates a completed run', async () => {
    const params = { threadKey: 'portable-approval', input: 'echo', runKey: 'logical-run' };
    const before = await env.PORTABLE_PROBE.snapshot();
    await inspect(env.PORTABLE_AGENT_WORKFLOW, 'portable-agent', async (instance) => {
      const workflow = await env.PORTABLE_AGENT_WORKFLOW.create({ id: 'portable-agent', params });
      await instance.waitForStepResult({ name: 'status:awaiting:0:echo-1' });
      const parked = await env.PORTABLE_PROBE.snapshot();
      expect(parked.tools).toBe(before.tools);
      expect(parked.models).toBe(before.models + 1);
      const approval = await env.PORTABLE_PROBE.approval(params.threadKey);
      expect(approval).not.toBeNull();
      await workflow.sendEvent({
        type: AGENT_APPROVAL_EVENT_TYPE,
        payload: { ...approval, decision: 'approve', approverId: 'operator' },
      });
      await instance.waitForStatus('complete');
      expect(await instance.getOutput()).toMatchObject({ text: 'finished', stopped: 'final' });
    });
    await inspect(env.PORTABLE_AGENT_WORKFLOW, 'portable-agent-duplicate', async (instance) => {
      await env.PORTABLE_AGENT_WORKFLOW.create({ id: 'portable-agent-duplicate', params });
      await instance.waitForStatus('complete');
      expect(await instance.getOutput()).toMatchObject({ text: 'finished' });
    });
    const after = await env.PORTABLE_PROBE.snapshot();
    expect(after.models).toBe(before.models + 2);
    expect(after.tools).toBe(before.tools + 1);
  });
});
