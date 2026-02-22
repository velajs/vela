import { InjectionToken } from '@velajs/vela';
import type { BindingRef } from './binding-ref';

// Internal tokens for binding refs — used by services
export const KV_BINDING_REF = new InjectionToken<BindingRef>('CF_KV_BINDING_REF');
export const D1_BINDING_REF = new InjectionToken<BindingRef>('CF_D1_BINDING_REF');
export const R2_BINDING_REF = new InjectionToken<BindingRef>('CF_R2_BINDING_REF');
export const QUEUE_BINDING_REF = new InjectionToken<BindingRef>('CF_QUEUE_BINDING_REF');

/**
 * Global registry of binding refs to initialize on first request.
 * Each module's `forRoot()` pushes its BindingRef here.
 * CloudflareFactory reads from this to populate bindings.
 */
export const bindingsRegistry: BindingRef[] = [];

export function clearBindingsRegistry(): void {
  bindingsRegistry.length = 0;
}
