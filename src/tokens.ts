import { InjectionToken } from '@velajs/vela';
import type { BindingRef } from './binding-ref';
import type { EnvRef } from './env-ref';

// Tokens for binding refs — used by services to receive the binding value.
export const KV_BINDING_REF = new InjectionToken<BindingRef>('CF_KV_BINDING_REF');
export const D1_BINDING_REF = new InjectionToken<BindingRef>('CF_D1_BINDING_REF');
export const R2_BINDING_REF = new InjectionToken<BindingRef>('CF_R2_BINDING_REF');
export const QUEUE_BINDING_REF = new InjectionToken<BindingRef>('CF_QUEUE_BINDING_REF');
export const DO_BINDING_REF = new InjectionToken<BindingRef>('CF_DO_BINDING_REF');
export const AI_BINDING_REF = new InjectionToken<BindingRef>('CF_AI_BINDING_REF');
export const VECTORIZE_BINDING_REF = new InjectionToken<BindingRef>('CF_VECTORIZE_BINDING_REF');
export const HYPERDRIVE_BINDING_REF = new InjectionToken<BindingRef>('CF_HYPERDRIVE_BINDING_REF');

// Token for the whole-env holder (full c.env), backing EnvService.
export const ENV_REF = new InjectionToken<EnvRef>('CF_ENV_REF');
