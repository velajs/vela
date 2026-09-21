import wasm from './cedar.wasm';
import { initializeCedar } from '../cedar/loader';
/** Wrangler bundles the packaged WASM module only when this entrypoint is imported. */
export const cloudflareCedar = () => initializeCedar(wasm);
