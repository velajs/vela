/**
 * Public option + result shapes for the loopback dev host.
 */

/** Minimal one-time-warning logger surface; a Vite `Logger` or CLI logger satisfies it. */
export interface WarnLogger {
  /** Emit a message at most once (deduped by the logger). */
  warnOnce?: (message: string) => void;
  /** Fallback plain warn used when {@link warnOnce} is absent. */
  warn?: (message: string) => void;
}

/** Options accepted by {@link startStudioServer} and {@link studioMiddleware}. */
export interface StudioHostOptions {
  /** Project root used for asset resolution hints; defaults to `process.cwd()`. */
  cwd?: string;
  /** Loopback interface to bind; defaults to `127.0.0.1`. Non-loopback is refused at request time. */
  host?: string;
  /** Port to listen on; defaults to `0` (an ephemeral port). */
  port?: number;
  /**
   * Origin of the running Vela app the admin API is proxied to (e.g.
   * `http://127.0.0.1:8787` or `https://app.example.com`). Required.
   */
  workerOrigin: string;
  /**
   * The MASTER admin bearer token. It lives ONLY in the host process: the proxy
   * adds `Authorization: Bearer <token>` server-side when forwarding to
   * {@link workerOrigin}, so the browser NEVER receives it. Omit for an app that
   * needs no admin auth. The bundled StudioModule requires a configured token.
   */
  adminToken?: string;
  /** Server admin-mount prefix proxied to the app; defaults to `/_vela/admin`. */
  adminPath?: string;
  /** SPA router base path the Studio mounts under in the browser; defaults to `/`. */
  basePath?: string;
  /**
   * Where `@velajs/studio-ui/standalone` is resolved from; defaults to this
   * module's own URL. Tests point it elsewhere to exercise the missing-assets path.
   */
  resolveFrom?: string;
  /** Optional `fetch` used by the proxy (injected in tests). Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Optional one-time-warning logger for the missing-assets hint. */
  logger?: WarnLogger;
}

/** A started {@link startStudioServer} instance. */
export interface StudioServer {
  /** The loopback URL the Studio is served at (e.g. `http://127.0.0.1:51234/`). */
  readonly url: string;
  /** The bound port. */
  readonly port: number;
  /** Stop listening and release the socket. */
  close(): Promise<void>;
}

/** Resolved prebuilt standalone assets (the directory + entry/style filenames). */
export interface StudioAssets {
  /** Absolute path of `@velajs/studio-ui`'s `dist/standalone` directory. */
  readonly dir: string;
  /** The bundle entry filename (`studio.js`). */
  readonly scriptFile: string;
  /** The stylesheet filename (`styles.css`). */
  readonly styleFile: string;
}
