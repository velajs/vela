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
import type { AdminRpcMeta } from '../studio.types';

export const AdminRpc = createDiscoverableDecorator<AdminRpcMeta>('vela:studio:rpc');
