/**
 * `@AdminRpc({ op })` marks a provider method as the handler for a Studio op.
 * Discoverable by the decorator itself (no string key at the call site); the
 * dispatch registry builds the op→handler map from
 * `discovery.methodsWithMeta(AdminRpc)` at bootstrap.
 *
 * The meta stores ONLY the op name; mode / feature / gate / destructive come
 * from `STUDIO_OP_META[op]` — one source of truth, no duplication.
 */
import { createDiscoverableDecorator } from '@velajs/vela';
import type { AdminConfirmSummaryMeta, AdminRpcMeta } from '../studio.types';

export const AdminRpc = createDiscoverableDecorator<AdminRpcMeta>('vela:studio:rpc');

/**
 * `@AdminConfirmSummary({ op })` marks a method as the human-summary provider
 * for a destructive op's 428 confirm challenge. Discovered by the dispatch
 * registry the same way as `@AdminRpc`; the registry calls it with `(ctx, args)`
 * to build `error.details.summary` when it mints a challenge token. Generic —
 * future timeTravel/transfer confirm flows register their own.
 */
export const AdminConfirmSummary = createDiscoverableDecorator<AdminConfirmSummaryMeta>(
  'vela:studio:confirm-summary',
);
