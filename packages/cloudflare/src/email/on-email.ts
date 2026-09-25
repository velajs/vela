import { MetadataRegistry, registerEntrypointKind } from '@velajs/vela/module-kit';
import { registerWorkerEvent } from '../worker-events';
import { EMAIL_METADATA, dispatchEmail, type OnEmailMetadata } from './email-dispatch';

// The entrypoint kind, declared next to its decorator; importing the decorator
// also gives every Worker of the isolate its `email` handler.
registerEntrypointKind({ kind: 'cf:email', metaKey: EMAIL_METADATA, level: 'method' });
registerWorkerEvent('email', (application, message) => dispatchEmail(application, message));

/** Options of {@link OnEmail}. */
export interface OnEmailOptions {
  /**
   * The envelope recipients (`message.to`) this handler accepts, such as
   * `'support@example.com'`, compared without regard to case. Without it the
   * handler accepts the mail that no handler lists its recipient for.
   */
  readonly to?: string | readonly string[];
}

/** A method decorator whose method receives an Email Workers message. */
export type OnEmailDecorator = <Handler extends (message: ForwardableEmailMessage) => unknown>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<Handler>,
) => void;

function recipients(to: OnEmailOptions['to']): string[] | undefined {
  if (to === undefined) return undefined;
  const list: readonly unknown[] = typeof to === 'string' ? [to] : to;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError('@OnEmail({ to }) takes an address or a non-empty list of addresses.');
  }
  return list.map((address) => {
    if (typeof address !== 'string' || address.trim() === '' || !address.includes('@')) {
      throw new TypeError(`@OnEmail({ to }) takes email addresses, not ${String(address)}.`);
    }
    return address.trim().toLowerCase();
  });
}

/**
 * Handle Email Workers messages (entrypoint kind `cf:email`). The method of an
 * `@Injectable()` provider receives the native `ForwardableEmailMessage`,
 * which it can read (`raw`, `headers`), `forward()`, `reply()` or
 * `setReject()`:
 *
 * ```ts
 * @Injectable()
 * export class SupportInbox {
 *   @OnEmail({ to: 'support@example.com' })
 *   async receive(message: ForwardableEmailMessage): Promise<void> {
 *     await message.forward('team@example.com');
 *   }
 * }
 * ```
 *
 * Importing it gives the Worker (`app.worker`) its `email` handler. A message
 * goes to the handlers whose `to` lists its envelope recipient, else to those
 * without `to`; each runs in its own execution scope through its scoped
 * guards, interceptors and filters. A message no handler accepts is rejected
 * with a permanent SMTP error, never silently dropped. A failure is reported
 * (`edge: 'email'`) and rethrown to the platform unless a scoped filter
 * handles it.
 */
export function OnEmail(options: OnEmailOptions = {}): OnEmailDecorator {
  const to = recipients(options.to);
  return (target, key) => {
    if (typeof key !== 'string') throw new TypeError('@OnEmail() decorates a string-named method.');
    MetadataRegistry.appendCustomClassMeta<OnEmailMetadata>(
      target.constructor,
      EMAIL_METADATA,
      to === undefined ? { methodName: key } : { methodName: key, to },
    );
  };
}
