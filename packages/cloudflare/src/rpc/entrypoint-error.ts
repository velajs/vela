import { HttpException, renderHttpError, type RenderedHttpError } from '@velajs/vela';
import type { ErrorReporter } from '@velajs/vela/module-kit';

const NAME = 'EntrypointError';
const CODE = /^[A-Za-z0-9_.:-]{1,160}$/;
const MAX_MESSAGE_LENGTH = 2048;

/** What a failed JS-RPC call of a Vela entrypoint carries across the RPC boundary. */
export interface EntrypointErrorInit {
  /** An HTTP error status, 400–599. */
  readonly status: number;
  /** A stable error code, such as `not_found` or `internal`. */
  readonly code: string;
  readonly message: string;
  /** Client-safe details of a client fault (4xx), such as validation issues. */
  readonly details?: unknown;
}

/**
 * The one error the JS-RPC methods of a Vela entrypoint reject with: a
 * Durable Object from `VelaDurableObject()` and a service entrypoint from
 * `VelaEntrypoint()`. The entrypoint reports the original error first, then
 * renders it as HTTP renders a response (`renderHttpError`): a 4xx
 * `HttpException` or branded `VelaError` keeps its code, message and details;
 * anything else becomes `500 internal "Internal Server Error"`. Only these own
 * properties cross the RPC boundary: no stack frames, causes or other fields of
 * the original.
 *
 * workerd rebuilds it on the caller's side as a plain `Error` with the same
 * `name`, `status`, `code`, `message` and `details`; read it with
 * {@link isEntrypointError}. That needs a Worker `compatibility_date` of
 * 2026-04-21 or later, or the `enhanced_error_serialization` compatibility
 * flag: before it, workerd delivers only an `Error` whose message is
 * `EntrypointError: <message>`, without the status, code or details
 * (`vela deploy check` warns about it). A host may throw one itself, for
 * example to pass on another entrypoint's failure: a 4xx one keeps its code,
 * message and details, a 5xx one only its status.
 */
export class EntrypointError extends Error implements EntrypointErrorInit {
  override readonly name = NAME;
  readonly status: number;
  readonly code: string;
  declare readonly details?: unknown;

  constructor(init: EntrypointErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    if (init.details !== undefined) {
      Object.defineProperty(this, 'details', {
        value: init.details,
        enumerable: true,
        writable: false,
        configurable: true,
      });
    }
    // workerd serializes the stack across RPC; it would disclose the entrypoint's frames.
    this.stack = `${NAME}: ${this.message}`;
  }
}

/**
 * Whether `error` is a failed JS-RPC call of a Vela entrypoint: an
 * {@link EntrypointError}, or the plain `Error` workerd delivers for one to
 * the caller. On a compatibility date before 2026-04-21 without
 * `enhanced_error_serialization`, workerd drops the error's properties, so
 * this is false.
 */
export function isEntrypointError(error: unknown): error is EntrypointError {
  if (typeof error !== 'object' || error === null) return false;
  return (
    Reflect.get(error, 'name') === NAME &&
    typeof Reflect.get(error, 'status') === 'number' &&
    typeof Reflect.get(error, 'code') === 'string' &&
    typeof Reflect.get(error, 'message') === 'string'
  );
}

/** @internal The redacted failure of an invocation that failed outside its pipeline. */
export function internalEntrypointError(): EntrypointError {
  return new EntrypointError({ status: 500, code: 'internal', message: 'Internal Server Error' });
}

// JSON-safe client details only: an RPC failure must stay serializable.
function clientDetails(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function fromRendered(rendered: Pick<RenderedHttpError, 'status' | 'body'>): EntrypointError {
  const status =
    Number.isInteger(rendered.status) && rendered.status >= 400 && rendered.status <= 599
      ? rendered.status
      : 500;
  const body: unknown = rendered.body;
  const wire: unknown =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined;
  const field = (name: string): unknown =>
    typeof wire === 'object' && wire !== null ? Reflect.get(wire, name) : undefined;
  const rawCode = field('code');
  const rawMessage = field('message');
  const code =
    typeof rawCode === 'string' && CODE.test(rawCode)
      ? rawCode
      : status >= 500
        ? 'internal'
        : 'error';
  const message =
    status >= 500 && code === 'internal'
      ? 'Internal Server Error'
      : typeof rawMessage === 'string'
        ? rawMessage.slice(0, MAX_MESSAGE_LENGTH)
        : 'Entrypoint request failed';
  const details = status < 500 ? clientDetails(field('details')) : undefined;
  return new EntrypointError({ status, code, message, details });
}

/**
 * An {@link EntrypointError} a host rethrows, such as another entrypoint's
 * failure: a client fault keeps its code, message and details; a server fault
 * keeps only its status, rendered like an `HttpException` of that status.
 */
function renderPassedOn(error: EntrypointError): Pick<RenderedHttpError, 'status' | 'body'> {
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }
  return renderHttpError(new HttpException('Entrypoint request failed', error.status));
}

/**
 * Render a failure of a JS-RPC call, after it was reported: the application's
 * `ExceptionHandler.render` first, then the HTTP renderer with server bodies
 * redacted. A 4xx {@link EntrypointError} passes through.
 */
export function renderEntrypointError(
  error: unknown,
  reporter: ErrorReporter,
  context: unknown,
): EntrypointError {
  if (isEntrypointError(error)) return fromRendered(renderPassedOn(error));
  const override = reporter.render(error, context);
  if (override instanceof Response) {
    void override.body?.cancel().catch(() => {});
    return fromRendered(
      renderHttpError(new HttpException('Entrypoint request failed', override.status)),
    );
  }
  return fromRendered(
    override ?? renderHttpError(error, { catalog: reporter.catalog, redactServerBodies: true }),
  );
}

/**
 * Render a failure of a Durable Object's `fetch()` as the HTTP edge does: the
 * application's `ExceptionHandler.render`, else the canonical JSON error body.
 */
export function renderEntrypointResponse(
  error: unknown,
  reporter: ErrorReporter,
  context: unknown,
): Response {
  if (isEntrypointError(error)) {
    const rendered = fromRendered(renderPassedOn(error));
    return Response.json(
      {
        error: {
          code: rendered.code,
          message: rendered.message,
          ...(rendered.details === undefined ? {} : { details: rendered.details }),
        },
      },
      { status: rendered.status },
    );
  }
  const override = reporter.render(error, context);
  if (override instanceof Response) return override;
  const rendered = override ?? renderHttpError(error, { catalog: reporter.catalog });
  const status = rendered.status >= 400 && rendered.status <= 599 ? rendered.status : 500;
  return Response.json(rendered.body, { status });
}
