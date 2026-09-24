import { z } from 'zod';
import type { StandardSchemaV1 } from '@velajs/vela/validation';
import type { Page } from '../adapter/query-types';
import { ConfigurationException } from '../envelope/errors';
import { defaultEnvelope } from '../envelope/envelope';
import type { EngineRequest, EngineResult } from '../kernel/engine-request';
import type { CrudResource } from '../kernel/resource';
import type { CrudContracts } from '../schema/contracts';

export interface CrudServiceContracts extends CrudContracts {
  create: StandardSchemaV1;
  update: StandardSchemaV1;
  response: StandardSchemaV1<unknown, Record<string, unknown>>;
}
export type CrudServiceInput<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;
export type CrudServiceOutput<C extends CrudServiceContracts> = StandardSchemaV1.InferOutput<
  C['response']
>;
export type CrudServiceId<C extends CrudServiceContracts> = C extends {
  id: infer S extends StandardSchemaV1;
}
  ? Extract<StandardSchemaV1.InferInput<S>, NonNullable<EngineRequest['id']>>
  : NonNullable<EngineRequest['id']>;
/** Explicit invocation context; never retained on the service instance. */
export type CrudServiceContext = Omit<EngineRequest, 'body' | 'id' | 'query'>;
export type CrudServiceReadContext = CrudServiceContext & Pick<EngineRequest, 'query'>;
export interface CrudServiceResult<T, Status extends number = number> {
  readonly status: Status;
  readonly data: T;
  readonly headers: Readonly<Record<string, string>>;
}
export type CrudServiceReadResult<T> =
  | CrudServiceResult<T, 200>
  | CrudServiceResult<undefined, 304>;
export interface CrudService<C extends CrudServiceContracts> {
  create(
    input: CrudServiceInput<C['create']>,
    context?: CrudServiceReadContext,
  ): Promise<CrudServiceResult<CrudServiceOutput<C>, 201>>;
  read(
    id: CrudServiceId<C>,
    context?: CrudServiceReadContext,
  ): Promise<CrudServiceReadResult<CrudServiceOutput<C>>>;
  update(
    id: CrudServiceId<C>,
    input: CrudServiceInput<C['update']>,
    context?: CrudServiceReadContext,
  ): Promise<CrudServiceResult<CrudServiceOutput<C>, 200>>;
  delete(
    id: CrudServiceId<C>,
    context?: CrudServiceReadContext,
  ): Promise<CrudServiceResult<{ deleted: true }, 200>>;
  list(
    query?: EngineRequest['query'],
    context?: CrudServiceContext,
  ): Promise<CrudServiceResult<Page<CrudServiceOutput<C>>, 200>>;
}

/** A noncanonical result cannot be presented as schema-validated service data. */
export class CrudServiceResponseError extends Error {
  constructor(readonly response: EngineResult) {
    super(`Unexpected CRUD service response (${response.status})`);
    this.name = 'CrudServiceResponseError';
  }
}
const pageInfo = z.object({
  page: z.number().int().nonnegative(),
  per_page: z.number().int().positive(),
  total_count: z.number().nonnegative().optional(),
  total_pages: z.number().int().nonnegative().optional(),
  has_next_page: z.boolean(),
  has_prev_page: z.boolean(),
  next_cursor: z.string().optional(),
});

/** Bind to the resource's actual contracts, not an unrelated generic schema.
 * Input and response transformations execute once, inside the existing engine.
 * Custom envelopes and post-response afterList replacements stay on execute(). */
export function bindCrudService<const C extends CrudServiceContracts>(
  resource: CrudResource,
  contracts: C,
): CrudService<C> {
  const bound = { ...contracts };
  const assertBinding = (): void => {
    const actual = { ...resource.model.contracts, ...resource.config.contracts };
    if (
      resource.createSchema !== bound.create ||
      resource.updateSchema !== bound.update ||
      actual.response !== bound.response ||
      actual.id !== bound.id
    )
      throw new ConfigurationException('CRUD service contracts must match the compiled resource');
    if (resource.config.envelope !== undefined && resource.config.envelope !== defaultEnvelope)
      throw new ConfigurationException('CRUD service requires the default response envelope');
    if (resource.config.hooks?.afterList)
      throw new ConfigurationException(
        'CRUD service cannot type afterList replacements; use projectPage or transformList before response validation',
      );
  };
  assertBinding();
  const execute = (
    verb: 'create' | 'read' | 'update' | 'delete' | 'list',
    request: EngineRequest,
  ) => {
    assertBinding();
    return resource.execute(verb, request);
  };
  // This cast connects the identity-checked response contract to the dynamic
  // engine result. The engine has already validated/transformed every row;
  // parsing again would corrupt non-idempotent response transformations.
  const row = (value: unknown): CrudServiceOutput<C> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError('Expected a CRUD service response record');
    return value as CrudServiceOutput<C>;
  };
  return Object.freeze({
    async create(input, context = {}) {
      const result = await execute('create', { ...context, body: input });
      const body = success(result, 201);
      return resultOf(result, 201, row(body.result));
    },
    async read(id, context = {}) {
      const result = await execute('read', { ...context, id: requestId(id) });
      if (result.status === 304) return resultOf(result, 304, undefined);
      const body = success(result, 200);
      return resultOf(result, 200, row(body.result));
    },
    async update(id, input, context = {}) {
      const result = await execute('update', { ...context, id: requestId(id), body: input });
      const body = success(result, 200);
      return resultOf(result, 200, row(body.result));
    },
    async delete(id, context = {}) {
      const result = await execute('delete', { ...context, id: requestId(id) });
      const body = success(result, 200);
      if (
        !body.result ||
        typeof body.result !== 'object' ||
        !('deleted' in body.result) ||
        body.result.deleted !== true
      )
        throw new CrudServiceResponseError(result);
      return resultOf(result, 200, { deleted: true as const });
    },
    async list(query, context = {}) {
      const result = await execute('list', { ...context, query });
      const body = success(result, 200);
      if (!Array.isArray(body.result) || !('result_info' in body))
        throw new CrudServiceResponseError(result);
      return resultOf(result, 200, {
        result: body.result.map(row),
        result_info: pageInfo.parse(body.result_info),
      });
    },
  } satisfies CrudService<C>);
}

function success(
  result: EngineResult,
  status: number,
): { result: unknown } & Record<string, unknown> {
  const body = result.body;
  if (
    result.status !== status ||
    !body ||
    typeof body !== 'object' ||
    !('success' in body) ||
    body.success !== true ||
    !('result' in body)
  )
    throw new CrudServiceResponseError(result);
  return { ...body, result: body.result };
}
function resultOf<T, S extends number>(
  result: EngineResult,
  status: S,
  data: T,
): CrudServiceResult<T, S> {
  return { status, data, headers: Object.freeze({ ...result.headers }) };
}
function requestId(value: unknown): NonNullable<EngineRequest['id']> {
  // Preserve the raw identifier for the engine's id contract, including numeric
  // composite parts. Scalar identifiers follow the HTTP string representation.
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id: Record<string, string | number> = {};
    for (const [key, part] of Object.entries(value)) {
      if (typeof part !== 'string' && !(typeof part === 'number' && Number.isFinite(part)))
        throw new TypeError('CRUD service identifiers must be strings or composite records');
      Object.defineProperty(id, key, { value: part, enumerable: true });
    }
    return id;
  }
  throw new TypeError('CRUD service identifiers must be strings or composite records');
}
