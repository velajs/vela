import { MetadataRegistry, registerEntrypointKind } from '@velajs/vela/module-kit';
import { MAIL_INBOUND_METADATA } from '../mail.tokens';
import type { InboundEmail } from './parse';

/** Per-handler metadata written by {@link OnInboundEmail}. */
export interface OnInboundEmailMeta {
  methodName: string | symbol;
  /** Optional router predicate — narrows WHICH handler runs; never relaxes the gate. */
  match?: (email: InboundEmail) => boolean;
}

// The inbound entrypoint kind, declared at import time next to the decorator —
// the same shape queue/cron kinds use. Method-level: one entrypoint per
// decorated handler, flattened from the class-level list.
registerEntrypointKind({ kind: 'mail:inbound', metaKey: MAIL_INBOUND_METADATA, level: 'method' });

/**
 * Mark a method as an inbound-email handler:
 *
 * ```ts
 * @Injectable()
 * class SupportInbox {
 *   @OnInboundEmail({ match: (e) => e.to.some((a) => a.includes('support@')) })
 *   async handle(email: InboundEmail) { ... }  // runs ONLY if the app gate passed
 * }
 * ```
 *
 * Gating is app-level (a module option → the `MAIL_INBOUND_GATE` global token),
 * evaluated once by the dispatcher before any handler; `match` only ROUTES.
 */
export function OnInboundEmail(
  options: {
    match?: (email: InboundEmail) => boolean;
  } = {},
): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const meta: OnInboundEmailMeta =
      options.match === undefined
        ? { methodName: propertyKey }
        : { methodName: propertyKey, match: options.match };
    MetadataRegistry.appendCustomClassMeta<OnInboundEmailMeta>(
      target.constructor,
      MAIL_INBOUND_METADATA,
      meta,
    );
  };
}
