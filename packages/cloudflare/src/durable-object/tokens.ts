import { InjectionToken } from '@velajs/vela';

/**
 * This Durable Object's `DurableObjectState` (`ctx` in a hand-written class),
 * injectable in the application context the object boots: storage, id,
 * `blockConcurrencyWhile`, WebSocket hibernation. Registered only inside a
 * Durable Object; a provider the Worker builds too injects it with `@Optional()`.
 */
export const DO_STATE = /* @__PURE__ */ new InjectionToken<DurableObjectState>('vela.DO_STATE');

/** This Durable Object's transactional storage, `DO_STATE.storage`. */
export const DO_STORAGE = /* @__PURE__ */ new InjectionToken<DurableObjectStorage>(
  'vela.DO_STORAGE',
);

/** This Durable Object's id, `DO_STATE.id` (`id.name` when addressed by name). */
export const DO_ID = /* @__PURE__ */ new InjectionToken<DurableObjectId>('vela.DO_ID');
