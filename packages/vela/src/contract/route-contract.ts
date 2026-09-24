import {
  resolveRouteContract,
  type RouteFormBody,
  type RouteJsonBody,
  type RouteMultipartBody,
  type RouteResponseOptions,
} from '../http/route-contract';
import type { ValidationSchema } from '../validation/parse-schema';

/** HTTP methods a route contract can declare. */
export type RouteContractMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

/**
 * A route's HTTP contract, declared once and shared by the server and a
 * browser client. The server serves it with `@Post(contract)` or
 * `@Post('/:id', contract)` (the decorator's method must match); `ContractApp`
 * turns contracts into `hc` client types, and `vela client generate` emits the
 * same client types for a contract as for the equivalent decorator options.
 */
export interface RouteContract<
  Method extends string = RouteContractMethod,
> extends RouteResponseOptions {
  readonly method: Method;
  /**
   * The path the application serves, with the global prefix and `:params`
   * (`/api/todos/:id`). Needed for `ContractApp`; the server checks it at
   * startup against the path the decorator composes.
   */
  readonly path?: string;
  /** Route name for URL generation and the OpenAPI `operationId`. */
  readonly name?: string;
  /** Path parameters, validated before the handler runs. */
  readonly params?: ValidationSchema;
  /** Query parameters; keys the schema declares as arrays always arrive as arrays. */
  readonly query?: ValidationSchema;
  /** The request body: JSON unless `form` or `multipart` is set. */
  readonly body?: ValidationSchema;
  /** Bound a JSON body. */
  readonly json?: RouteJsonBody;
  /** Accept an `application/x-www-form-urlencoded` body. */
  readonly form?: RouteFormBody;
  /** Accept a `multipart/form-data` body. */
  readonly multipart?: RouteMultipartBody;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

/**
 * Declare a route contract. It imports no server code, so a browser bundle
 * can share it. The declaration is checked here, as the decorator would.
 *
 * @example
 * ```ts
 * export const createTodo = defineRoute({
 *   method: 'POST',
 *   path: '/todos',
 *   body: CreateTodo,
 *   response: Todo,
 * });
 *
 * // server, in @Controller('/todos')
 * @Post(createTodo)
 * create(@Body() body: ContractBody<typeof createTodo>) { … }
 *
 * // browser
 * const client = hc<ContractApp<[typeof createTodo]>>(origin);
 * ```
 */
export function defineRoute<const Contract extends RouteContract>(contract: Contract): Contract {
  if (!METHODS.includes(contract.method))
    throw new TypeError(`Route contract method must be one of ${METHODS.join(', ')}`);
  resolveRouteContract(contract.method, contract);
  return Object.freeze({ ...contract });
}
