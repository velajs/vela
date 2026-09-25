import type { EntrypointExecutionContext } from '@velajs/vela/module-kit';
import type { CloudflareApplication } from '../cloudflare-application';
import { entrypointInvoker, platformSettlement, settleInvocations } from '../host/host-invoker';

/** The metadata key `@OnEmail()` records its handlers under (entrypoint kind `cf:email`). */
export const EMAIL_METADATA = 'cloudflare:email';

/** One `@OnEmail()` handler: its method and the recipients it accepts. */
export interface OnEmailMetadata {
  readonly methodName: string;
  /** Lowercased envelope recipients; undefined for a handler of every other recipient. */
  readonly to?: readonly string[];
}

/** The ExecutionContext guards, interceptors and filters receive around an `@OnEmail()` handler. */
export type EmailExecutionContext = EntrypointExecutionContext<'cf:email'>;

/**
 * The reason a message no handler accepts is rejected with: a permanent SMTP
 * error the sending server reports to its sender.
 */
export const UNCLAIMED_EMAIL_REASON = 'No handler accepts mail for this address.';

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Validate `cf:email` entrypoint metadata. */
export function parseOnEmailMetadata(meta: unknown): OnEmailMetadata {
  if (typeof meta !== 'object' || meta === null) throw new Error('Invalid @OnEmail() metadata.');
  const methodName: unknown = Reflect.get(meta, 'methodName');
  const to: unknown = Reflect.get(meta, 'to');
  if (typeof methodName !== 'string' || (to !== undefined && !isStringList(to))) {
    throw new Error('Invalid @OnEmail() metadata.');
  }
  return to === undefined ? { methodName } : { methodName, to };
}

/** Whether the platform's payload is an Email Workers message. */
function isEmailMessage(value: unknown): value is ForwardableEmailMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'from') === 'string' &&
    typeof Reflect.get(value, 'to') === 'string' &&
    typeof Reflect.get(value, 'setReject') === 'function'
  );
}

const warned = new WeakSet<CloudflareApplication>();

// A handler failure reaches the platform unless a scoped filter handles it.
const emailSettlement = platformSettlement(false);

/**
 * Deliver an Email Workers message to the application's `@OnEmail()`
 * handlers: those whose `to` lists its envelope recipient, or else those
 * without `to`. Each runs in its own execution scope through its scoped
 * guards, interceptors and filters, with the native message. When no handler
 * accepts it, the message is rejected with {@link UNCLAIMED_EMAIL_REASON}
 * rather than dropped. A failure is reported (`edge: 'email'`) and, unless a
 * filter handles it, rethrown once every handler settled.
 */
export async function dispatchEmail(
  application: CloudflareApplication,
  message: unknown,
): Promise<void> {
  if (!isEmailMessage(message)) throw new TypeError('The email handler received no email message.');
  const entries = application.entrypoints.ofKind('cf:email', parseOnEmailMetadata);
  const recipient = message.to.toLowerCase();
  const addressed = entries.filter((entry) => entry.meta.to?.includes(recipient) === true);
  const handlers =
    addressed.length > 0 ? addressed : entries.filter((entry) => entry.meta.to === undefined);
  if (handlers.length === 0) {
    message.setReject(UNCLAIMED_EMAIL_REASON);
    if (!warned.has(application) && application.getContainer().getDiagnostics() !== 'silent') {
      warned.add(application);
      console.warn(
        `[vela] An email arrived for a recipient no @OnEmail() handler accepts, and was rejected ` +
          `(${entries.length} handler${entries.length === 1 ? '' : 's'} declared). Add ` +
          '@OnEmail() without `to` to accept every other recipient.',
      );
    }
    return;
  }
  const container = application.getContainer();
  await settleInvocations(
    handlers.map(async (entry) =>
      entrypointInvoker(container, entry, 'email').invoke({
        kind: 'cf:email',
        method: entry.meta.methodName,
        args: [message],
        payload: message,
        settlement: emailSettlement,
      }),
    ),
  );
}
