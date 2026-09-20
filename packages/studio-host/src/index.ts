/**
 * `@velajs/studio-host` — the Node-only loopback dev host.
 *
 * Serves the prebuilt Vela Studio SPA on localhost and safely proxies the admin
 * API to a running Vela app: the master admin token lives ONLY in this process
 * and is injected as `Authorization: Bearer` server-side, so the browser never
 * receives it (see {@link proxyToWorker}). Node builtins are used freely — this
 * package is never edge-bundled.
 */
export const STUDIO_HOST_VERSION = '1';

export { startStudioServer } from './server';
export { studioMiddleware } from './middleware';
export type {
  StudioMiddleware,
  StudioMiddlewareContext,
  StudioMiddlewareOptions,
} from './middleware';
export { createStudioHandler } from './handler';
export type { StudioRequestHandler } from './handler';
export { proxyToWorker } from './proxy';
export type { ProxyOptions } from './proxy';
export { renderStudioHtml, renderMissingAssetsHtml } from './render-html';
export type { StudioHtmlConfig } from './render-html';
export {
  assetContentType,
  isStandaloneModulePath,
  loadStudioAssets,
  readStandaloneAsset,
  resolveContainedFile,
  resolveStandaloneDirectory,
  studioAssetsStamp,
} from './assets';
export {
  csrfRejectionReason,
  hostnameOf,
  isLoopbackAddress,
  transportRejectionReason,
} from './gates';
export { DEFAULT_ADMIN_PATH, DEFAULT_BASE_PATH, DEFAULT_HOST } from './constants';
export type { StudioAssets, StudioHostOptions, StudioServer, WarnLogger } from './types';
