import { registerHooks } from 'node:module';
import { isRecord } from './files.js';

/**
 * Node stand-ins for the `cloudflare:*` runtime modules, so the CLI can load a
 * Worker entry and read its metadata outside workerd. They carry the exports
 * the platform declares with inert behavior: construction works (a Durable
 * Object or Workflow class can extend them), and runtime-only operations such
 * as opening a socket throw.
 */
const unavailable = (name: string) =>
  `function ${name}() { throw new Error(${JSON.stringify(
    `${name}() is a Workers runtime API; the Vela CLI loads the Worker in Node for its metadata only.`,
  )}); }`;

const BASE = `class Base { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }`;

const STUBS: Readonly<Record<string, string>> = {
  'cloudflare:workers': `${BASE}
export class DurableObject extends Base {}
export class WorkerEntrypoint extends Base {}
export class WorkflowEntrypoint extends Base {}
export class RpcTarget {}
export const RpcStub = class RpcStub { constructor(value) { return value; } };
export class WorkflowStep {}
export const env = {};
export const exports = {};
export const cache = {};
export const tracing = {};
export function waitUntil() {}
export function withEnv(_env, fn) { return fn(); }
export function withExports(_exports, fn) { return fn(); }
export function withEnvAndExports(_env, _exports, fn) { return fn(); }
`,
  'cloudflare:workflows': `export class NonRetryableError extends Error {
  constructor(message, name = 'NonRetryableError') { super(message); this.name = name; }
}
`,
  'cloudflare:email': `export class EmailMessage {
  constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; }
}
`,
  'cloudflare:sockets': `export ${unavailable('connect')}\n`,
  'cloudflare:node': `export ${unavailable('httpServerHandler')}
export ${unavailable('handleAsNodeRequest')}
export ${unavailable('connectHandler')}
export ${unavailable('handleAsNodeConnection')}
`,
  'cloudflare:pipelines': `${BASE}\nexport class PipelineTransformationEntrypoint extends Base {}\n`,
};

let installed = false;

/**
 * Resolve `cloudflare:*` imports to the stand-ins for the rest of this
 * process: the Worker's own files and the packages it imports load through
 * Node, which cannot resolve the scheme. Idempotent.
 */
export function installCloudflareStubs(): void {
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith('cloudflare:')) return nextResolve(specifier, context);
      if (!Object.hasOwn(STUBS, specifier)) {
        throw new Error(
          `${specifier} is not available when the Vela CLI loads the Worker in Node. ` +
            'Import it only where the Worker runs, or add a vela.config.ts that builds the app.',
        );
      }
      return { url: specifier, format: 'module', shortCircuit: true };
    },
    load(url, context, nextLoad) {
      const source = Object.hasOwn(STUBS, url) ? STUBS[url] : undefined;
      return source === undefined
        ? nextLoad(url, context)
        : { format: 'module', source, shortCircuit: true };
    },
  });
}

/** The platform base classes a Worker's exports are classified by. */
export interface CloudflareBaseClasses {
  readonly DurableObject: abstract new (...args: never[]) => unknown;
  readonly WorkflowEntrypoint: abstract new (...args: never[]) => unknown;
  readonly WorkerEntrypoint: abstract new (...args: never[]) => unknown;
}

function isConstructor(value: unknown): value is abstract new (...args: never[]) => unknown {
  return typeof value === 'function';
}

/**
 * The stand-in base classes the loaded modules share, imported through the
 * same module loader as the Worker entry (`load`).
 */
export async function cloudflareBaseClasses(
  load: (specifier: string) => Promise<unknown>,
): Promise<CloudflareBaseClasses> {
  installCloudflareStubs();
  const stub = await load('cloudflare:workers');
  const { DurableObject, WorkflowEntrypoint, WorkerEntrypoint } = isRecord(stub) ? stub : {};
  if (
    !isConstructor(DurableObject) ||
    !isConstructor(WorkflowEntrypoint) ||
    !isConstructor(WorkerEntrypoint)
  ) {
    throw new Error('The cloudflare:workers stand-in is incomplete.');
  }
  return { DurableObject, WorkflowEntrypoint, WorkerEntrypoint };
}
