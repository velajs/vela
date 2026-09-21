import * as web from '@cedar-policy/cedar-wasm/web';
import type { CedarBinding } from './binding';
let initialized = false;
/** Explicit initialization accepts a precompiled WASM module; no fetch, eval or Node. */
export function initializeCedar(module: WebAssembly.Module): CedarBinding {
  if (!initialized) {
    web.initSync({ module });
    initialized = true;
  }
  if (!web.getCedarLangVersion().startsWith('4.')) throw new Error('Cedar 4.x is required');
  return web;
}
