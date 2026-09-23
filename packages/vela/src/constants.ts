export const METADATA_KEYS = {
  // DI
  INJECTABLE: 'vela:injectable',
  INJECT: 'vela:inject',
  SCOPE: 'vela:scope',

  // Module
  MODULE: 'vela:module',
  MODULE_OPTIONS: 'vela:module-options',

  // HTTP
  CONTROLLER: 'vela:controller',
  ROUTES: 'vela:routes',
  PARAMS: 'vela:params',
  HTTP_CODE: 'vela:http-code',
  RESPONSE_HEADERS: 'vela:response-headers',
  REDIRECT: 'vela:redirect',

  // Pipeline
  CATCH: 'vela:catch',

  // CRUD
  CRUD: 'vela:crud',
} as const;

export const HttpMethod = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE',
  OPTIONS: 'OPTIONS',
  HEAD: 'HEAD',
  ALL: 'ALL',
} as const;
export type HttpMethod = (typeof HttpMethod)[keyof typeof HttpMethod];

export const ParamType = {
  BODY: 'body',
  QUERY: 'query',
  PARAM: 'param',
  HEADERS: 'headers',
  REQUEST: 'request',
  RESPONSE: 'response',
  IP: 'ip',
  COOKIE: 'cookie',
  RAW_BODY: 'raw_body',
} as const;
export type ParamType = (typeof ParamType)[keyof typeof ParamType];

export const Scope = {
  DEFAULT: 'default',
  TRANSIENT: 'transient',
  REQUEST: 'request',
} as const;
export type Scope = (typeof Scope)[keyof typeof Scope];
