import { z } from 'zod';

// Documented Workers Builds envelope with synthetic values, not an account delivery capture.
// https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/#buildsucceeded
export function workerBuildSucceeded() {
  return {
    type: 'cf.workersBuilds.worker.build.succeeded',
    source: { type: 'workersBuilds.worker', workerName: 'example-worker' },
    payload: {
      buildUuid: 'build-12345678-90ab-cdef-1234-567890abcdef',
      status: 'success',
      buildOutcome: 'success',
      createdAt: '2025-05-01T02:48:57.132Z',
      initializingAt: '2025-05-01T02:48:58.132Z',
      runningAt: '2025-05-01T02:48:59.132Z',
      stoppedAt: '2025-05-01T02:50:15.132Z',
      buildTriggerMetadata: {
        buildTriggerSource: 'push_event',
        branch: 'main',
        commitHash: 'abc123def456',
        commitMessage: 'Update example worker',
        author: 'developer@example.com',
        buildCommand: 'npm run build',
        deployCommand: 'wrangler deploy',
        rootDirectory: '/',
        repoName: 'example-worker',
        providerAccountName: 'example-account',
        providerType: 'github',
      },
    },
    metadata: {
      accountId: '00000000000000000000000000000000',
      eventSubscriptionId: '11111111111111111111111111111111',
      eventSchemaVersion: 1,
      eventTimestamp: '2025-05-01T02:48:57.132Z',
    },
  };
}

// An application can validate just the fields its handler consumes.
export const buildPayloadSchema = z.object({
  buildUuid: z.string().min(1),
  status: z.literal('success'),
});
export const buildEventExpectation = {
  type: 'cf.workersBuilds.worker.build.succeeded',
  source: { type: 'workersBuilds.worker', workerName: 'example-worker' },
  schema: buildPayloadSchema,
};
export const eventConsumerExpectation = {
  queue: 'platform-events',
  accountId: '00000000000000000000000000000000',
  eventSubscriptionIds: ['11111111111111111111111111111111'],
};
