// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as cloudflareTest from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { SignupParams } from './entry';

/** What `cloudflare:test` offers to steer one Workflow instance. */
interface WorkflowInstanceIntrospector {
  modify(
    fn: (modifier: {
      disableSleeps(steps?: { name: string }[]): Promise<void>;
      disableRetryDelays(steps?: { name: string }[]): Promise<void>;
    }) => Promise<void>,
  ): Promise<WorkflowInstanceIntrospector>;
  waitForStatus(status: InstanceStatus['status']): Promise<void>;
  getOutput(): Promise<unknown>;
  getError(): Promise<{ name: string; message: string }>;
  dispose(): Promise<void>;
}

/** The `cloudflare:test` helpers these specs drive. */
interface WorkersTestPool {
  SELF: Fetcher;
  introspectWorkflowInstance(workflow: Workflow, id: string): Promise<WorkflowInstanceIntrospector>;
}
const pool: WorkersTestPool = cloudflareTest;

/** Run `test` against the introspected instance `id`, with sleeps and retry delays disabled. */
async function introspected(
  id: string,
  test: (instance: WorkflowInstanceIntrospector) => Promise<void>,
): Promise<void> {
  const instance = await pool.introspectWorkflowInstance(env.SIGNUP_WORKFLOW, id);
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

async function ledger(): Promise<{ users: string[]; charges: string[] }> {
  const response = await pool.SELF.fetch('https://worker.test/ledger');
  return response.json();
}

describe('VelaWorkflow under workerd', () => {
  it('types the binding with the params of the host run', () => {
    expectTypeOf<Parameters<typeof env.SIGNUP_WORKFLOW.create>[0]>().toEqualTypeOf<
      WorkflowInstanceCreateOptions<Readonly<SignupParams>> | undefined
    >();
  });

  it('runs the host with DI in the Worker application, retrying a failed step', async () => {
    await introspected('retry-ada', async (instance) => {
      await env.SIGNUP_WORKFLOW.create({
        id: 'retry-ada',
        params: { email: 'ada@example.com', failFirstAttempt: true },
      });
      await instance.waitForStatus('complete');
      expect(await instance.getOutput()).toMatchObject({
        email: 'ada@example.com',
        // The step failed once and the engine retried it: step semantics are intact.
        attempt: 2,
        probe: 'workerd-env',
      });
    });
    // The Workflow ran in the application the Worker's fetch handler uses.
    expect((await ledger()).users).toContain('ada@example.com');
  });

  it('builds request-scoped providers for each run', async () => {
    const runs: unknown[] = [];
    for (const id of ['scope-one', 'scope-two']) {
      // eslint-disable-next-line no-await-in-loop -- One instance at a time.
      await introspected(id, async (instance) => {
        await env.SIGNUP_WORKFLOW.create({ id, params: { email: `${id}@example.com` } });
        await instance.waitForStatus('complete');
        const output = await instance.getOutput();
        runs.push(
          typeof output === 'object' && output !== null ? Reflect.get(output, 'run') : null,
        );
      });
    }
    expect(runs[0]).toEqual(expect.any(String));
    expect(runs[1]).toEqual(expect.any(String));
    expect(runs[0]).not.toBe(runs[1]);
  });

  it('creates instances from Worker code through the workflow() binding reference', async () => {
    await introspected('from-worker', async (instance) => {
      const response = await pool.SELF.fetch('https://worker.test/ledger/signups/from-worker', {
        method: 'POST',
      });
      expect(await response.json()).toEqual({ id: 'from-worker' });
      await instance.waitForStatus('complete');
      expect(await instance.getOutput()).toMatchObject({ email: 'from-worker@example.com' });
    });
  });

  it('reports a failed run and rethrows it, so the engine honors NonRetryableError', async () => {
    await introspected('fatal', async (instance) => {
      await env.SIGNUP_WORKFLOW.create({
        id: 'fatal',
        params: { email: 'fatal@example.com', fatal: true },
      });
      await instance.waitForStatus('errored');
      // The engine ended the instance without retrying: it received the NonRetryableError itself.
      expect(await instance.getError()).toMatchObject({
        name: 'WorkflowFatalError',
        message: expect.stringContaining('NonRetryableError'),
      });
    });
    // Reported first, through the Worker application's ExceptionHandler.
    expect(await env.BILLING.reported()).toContain('signup refused: secret policy detail');
  });
});
