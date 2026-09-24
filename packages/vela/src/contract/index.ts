// @velajs/vela/contract — browser-safe route contracts: `defineRoute` and the
// `hc` client types built from them. This entry imports no server code and
// installs no Reflect polyfill, so a browser bundle can share contracts with
// the server that serves them.

export { contractFormEncodings, defineRoute } from './route-contract';
export type { ContractFormEncoding, RouteContract, RouteContractMethod } from './route-contract';
export type {
  ContractApp,
  ContractBody,
  ContractEndpoint,
  ContractInput,
  ContractOutput,
  ContractParams,
  ContractQuery,
  ContractResponse,
  ContractSchema,
  ContractStatus,
} from './client';
