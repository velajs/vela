import './vela-env';
// @ts-expect-error `cloudflare:test` is the virtual module of the Workers Vitest pool
// (@cloudflare/vitest-plugin); it is typed below instead of by this package's build.
import * as cloudflareTest from 'cloudflare:test';
import { env as workersEnv } from 'cloudflare:workers';
import type { VelaEnv } from '@velajs/vela';
import { parseCronMetadata } from '@velajs/vela/module-kit';
import type { QueueJob, QueueJobDefinition, QueueJobInput } from '@velajs/vela/queue';
import { Test, type TestingModule, type TestingModuleBuilder } from '@velajs/testing';
import { CloudflareApplication } from './cloudflare-application';
import {
  cloudflareCreateOptions,
  configureCloudflareApplication,
  type CloudflareWorkerOptions,
} from './cloudflare-factory';
import { dispatchEmail } from './email/email-dispatch';
import type { CloudflareRoot } from './root-module';
import { dispatchTail } from './tail/tail-dispatch';

/** The `cloudflare:test` helpers this module drives (see @cloudflare/vitest-plugin). */
interface WorkersTestPool {
  createExecutionContext(): ExecutionContext;
  waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
  createScheduledController(options?: {
    scheduledTime?: Date | number;
    cron?: string;
  }): ScheduledController;
  createMessageBatch<Body>(
    queueName: string,
    messages: { id: string; timestamp: Date | number; attempts: number; body: Body }[],
  ): MessageBatch<Body>;
  getQueueResult(
    batch: MessageBatch,
    ctx: ExecutionContext,
  ): Promise<Omit<TestingQueueResult, 'error'>>;
}

const pool: WorkersTestPool = cloudflareTest;

export interface TestingWorkerOptions extends CloudflareWorkerOptions {
  /**
   * The Workers environment the application is built for and every event
   * carries. Defaults to the test Worker's `env` from `cloudflare:workers`,
   * with the bindings the Vitest pool's Wrangler configuration declares.
   */
  env?: VelaEnv;
  /**
   * Adjust the testing module before it compiles: `overrideProvider`,
   * `overrideModule().useModule()`, enhancer overrides and `useMocker`.
   */
  overrides?: (module: TestingModuleBuilder) => TestingModuleBuilder;
}

/** One message of a {@link TestingWorker.queue} batch. */
export interface TestingQueueMessage<Body = unknown> {
  readonly body: Body;
  /** Defaults to a random UUID. */
  readonly id?: string;
  /** The delivery attempt, 1-based; defaults to 1. */
  readonly attempts?: number;
  readonly timestamp?: Date | number;
}

/** What the queue handler did with a batch: `cloudflare:test`'s `getQueueResult()`, plus its outcome. */
export interface TestingQueueResult {
  /** `'exception'` when the handler rejected: Cloudflare then retries every message it did not acknowledge. */
  readonly outcome: 'ok' | 'exception';
  /** The handler's rejection, when `outcome` is `'exception'`. */
  readonly error?: unknown;
  readonly ackAll: boolean;
  readonly retryBatch: { readonly retry: boolean; readonly delaySeconds?: number };
  /** Ids of the messages acknowledged one by one. */
  readonly explicitAcks: readonly string[];
  readonly retryMessages: readonly { readonly msgId: string; readonly delaySeconds?: number }[];
}

/** The Worker's `fetch`, `queue`, `scheduled`, `email` and `tail` handlers for one test application. */
export interface TestingWorker {
  /** The compiled testing module: `get()`, `resolveInRequest()`, the fluent `http` client. */
  readonly module: TestingModule;
  readonly env: VelaEnv;
  /** Send a request through the Worker's `fetch` handler; a path resolves against `http://localhost`. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Deliver one batch of the physical `queue` to the Worker's `queue` handler. */
  queue(queue: string, messages: readonly TestingQueueMessage[]): Promise<TestingQueueResult>;
  /**
   * Fire the cron trigger `cron` and wait for its `@Cron` jobs. Rejects when
   * no job declares `cron`: Cloudflare delivers the literal trigger expression.
   */
  scheduled(cron: string, options?: { scheduledTime?: Date | number }): Promise<void>;
  /**
   * Deliver an Email Workers message (such as one from {@link emailMessage})
   * to the application's `@OnEmail()` handlers, as the Worker's `email`
   * handler does: a message no handler accepts is rejected.
   */
  email(message: ForwardableEmailMessage): Promise<void>;
  /** Deliver Tail Workers events (such as {@link traceItem}s) to its `@OnTail()` handlers. */
  tail(events: TraceItem[]): Promise<void>;
  /** Wait for background work (`waitUntil`) of every event, then close the application. */
  close(): Promise<void>;
}

/** An Email Workers message built by {@link emailMessage}, recording what handlers did with it. */
export interface TestingEmailMessage extends ForwardableEmailMessage {
  /** The reason passed to `setReject()`, when a handler rejected the message. */
  readonly rejectReason: string | undefined;
  /** The `forward()` calls, in order. */
  readonly forwards: readonly { readonly rcptTo: string; readonly headers?: Headers }[];
  /** The `reply()` calls, in order. */
  readonly replies: readonly (EmailMessage | EmailReplyMessageBuilder)[];
}

/** What {@link emailMessage} builds a message from. */
export interface TestingEmailInit {
  /** The envelope sender (`MAIL FROM`). */
  readonly from: string;
  /** The envelope recipient (`RCPT TO`), which `@OnEmail({ to })` routes on. */
  readonly to: string;
  readonly subject?: string;
  /** The plain-text body of the default raw message. */
  readonly text?: string;
  /** Further headers; `From`, `To` and `Subject` default from the fields above. */
  readonly headers?: HeadersInit;
  /** The raw RFC 5322 message; built from the headers and `text` by default. */
  readonly raw?: string | Uint8Array;
}

/**
 * An Email Workers message (`ForwardableEmailMessage`) for tests, in the
 * spirit of `cloudflare:test`'s `createMessageBatch()`: `raw`, `rawSize` and
 * `headers` describe the message, and `setReject()`, `forward()` and `reply()`
 * record what the handlers did (`rejectReason`, `forwards`, `replies`) instead
 * of sending anything.
 *
 * ```ts
 * const message = emailMessage({ from: 'ada@example.net', to: 'support@example.com', subject: 'Help' });
 * await worker.email(message);
 * expect(message.forwards).toEqual([{ rcptTo: 'team@example.com' }]);
 * ```
 */
export function emailMessage(init: TestingEmailInit): TestingEmailMessage {
  const headers = new Headers(init.headers);
  if (!headers.has('from')) headers.set('from', init.from);
  if (!headers.has('to')) headers.set('to', init.to);
  if (init.subject !== undefined && !headers.has('subject')) headers.set('subject', init.subject);
  const raw =
    init.raw ??
    `${[...headers].map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n${init.text ?? ''}`;
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
  let rejectReason: string | undefined;
  const forwards: { rcptTo: string; headers?: Headers }[] = [];
  const replies: (EmailMessage | EmailReplyMessageBuilder)[] = [];
  return {
    from: init.from,
    to: init.to,
    headers,
    rawSize: bytes.byteLength,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice());
        controller.close();
      },
    }),
    get rejectReason() {
      return rejectReason;
    },
    forwards,
    replies,
    setReject(reason: string): void {
      rejectReason = reason;
    },
    async forward(rcptTo: string, forwardHeaders?: Headers): Promise<EmailSendResult> {
      forwards.push(
        forwardHeaders === undefined ? { rcptTo } : { rcptTo, headers: forwardHeaders },
      );
      return { messageId: `forward-${forwards.length}@vela.test` };
    },
    async reply(message: EmailMessage | EmailReplyMessageBuilder): Promise<EmailSendResult> {
      replies.push(message);
      return { messageId: `reply-${replies.length}@vela.test` };
    },
  };
}

/**
 * A Tail Workers event (`TraceItem`) for tests: an `ok` fetch-less invocation
 * of the Worker `producer`, with `overrides` applied.
 */
export function traceItem(overrides: Partial<TraceItem> = {}): TraceItem {
  return {
    event: null,
    eventTimestamp: Date.now(),
    logs: [],
    exceptions: [],
    diagnosticsChannelEvents: [],
    scriptName: 'producer',
    outcome: 'ok',
    executionModel: 'stateless',
    truncated: false,
    cpuTime: 0,
    wallTime: 0,
    ...overrides,
  };
}

/**
 * Build `rootModule` as `createCloudflareWorker(rootModule, options)` does
 * (its adapters, then its `configure` hook), through `@velajs/testing`, and
 * drive its Worker handlers inside the Workers Vitest pool.
 *
 * ```ts
 * const worker = await createTestingWorker(AppModule, {
 *   overrides: (module) => module.overrideProvider(Mailer).useValue(fakeMailer),
 * });
 * const response = await worker.fetch('/todos');
 * const result = await worker.queue('todo-events', [queueJob('todos', todoCreated, { id: '1' })]);
 * await worker.scheduled('0 3 * * *');
 * await worker.close();
 * ```
 */
export async function createTestingWorker(
  rootModule: CloudflareRoot,
  options: TestingWorkerOptions = {},
): Promise<TestingWorker> {
  const { env = workersEnv, overrides, configure, ...appOptions } = options;
  const builder = Test.createTestingModule(
    { imports: [rootModule] },
    cloudflareCreateOptions({ ...appOptions, env }),
  );
  const module = await (overrides ? overrides(builder) : builder).compile();
  let app: CloudflareApplication;
  try {
    app = await configureCloudflareApplication(
      new CloudflareApplication(await module.createApplication(), env),
      env,
      configure,
    );
  } catch (error) {
    await module.close();
    throw error;
  }
  const contexts = new Set<ExecutionContext>();
  const context = (): ExecutionContext => {
    const ctx = pool.createExecutionContext();
    contexts.add(ctx);
    return ctx;
  };
  // A request completes once its response body is consumed: close() cancels
  // the bodies a test never read, so waiting for its background work ends.
  const responses = new Set<Response>();
  return {
    module,
    env,
    async fetch(input, init) {
      const request =
        typeof input === 'string' && input.startsWith('/')
          ? new Request(new URL(input, 'http://localhost'), init)
          : new Request(input, init);
      const response = await app.fetch(request, env, context());
      responses.add(response);
      return response;
    },
    async queue(queue, messages) {
      const batch = pool.createMessageBatch(
        queue,
        messages.map((message) => ({
          id: message.id ?? crypto.randomUUID(),
          timestamp: message.timestamp ?? Date.now(),
          attempts: message.attempts ?? 1,
          body: message.body,
        })),
      );
      const ctx = context();
      try {
        await app.queue(batch, env, ctx);
      } catch (error) {
        return { ...(await pool.getQueueResult(batch, ctx)), outcome: 'exception', error };
      }
      return { ...(await pool.getQueueResult(batch, ctx)), outcome: 'ok' };
    },
    async scheduled(cron, { scheduledTime } = {}) {
      const declared = app.entrypoints
        .ofKind('schedule:cron', parseCronMetadata)
        .map((entry) => entry.meta.expression);
      if (!declared.includes(cron)) {
        throw new Error(
          `No @Cron job declares ${JSON.stringify(cron)}. Declared: ` +
            `${declared.map((expression) => JSON.stringify(expression)).join(', ') || '(none)'}.`,
        );
      }
      const ctx = context();
      await app.scheduled(pool.createScheduledController({ cron, scheduledTime }), env, ctx);
      await pool.waitOnExecutionContext(ctx);
    },
    email: (message) => dispatchEmail(app, message),
    tail: (events) => dispatchTail(app, events),
    async close() {
      await Promise.all(
        [...responses].map((response) =>
          response.bodyUsed ? undefined : response.body?.cancel().catch(() => {}),
        ),
      );
      responses.clear();
      await Promise.all([...contexts].map((ctx) => pool.waitOnExecutionContext(ctx)));
      contexts.clear();
      await module.close();
    },
  };
}

/**
 * A queue message carrying a Vela job envelope, as `QueueClient.add()` sends
 * it: `queue` is the logical queue a `@Processor` handles, and `job` a job
 * definition (whose wire input `data` must match) or a job name.
 */
export function queueJob<const D extends QueueJobDefinition>(
  queue: string,
  job: D,
  data: QueueJobInput<D>,
  options?: { id?: string; attempts?: number },
): TestingQueueMessage<QueueJob>;
export function queueJob(
  queue: string,
  job: string,
  data: unknown,
  options?: { id?: string; attempts?: number },
): TestingQueueMessage<QueueJob>;
export function queueJob(
  queue: string,
  job: string | QueueJobDefinition,
  data: unknown,
  { id = crypto.randomUUID(), attempts = 1 }: { id?: string; attempts?: number } = {},
): TestingQueueMessage<QueueJob> {
  const name = typeof job === 'string' ? job : job.name;
  return { id, attempts, body: { id, queue, name, data, attempt: attempts } };
}
