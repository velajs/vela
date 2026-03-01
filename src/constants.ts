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

export enum HttpMethod {
  GET = 'get',
  POST = 'post',
  PUT = 'put',
  PATCH = 'patch',
  DELETE = 'delete',
  OPTIONS = 'options',
  HEAD = 'head',
}

export enum ParamType {
  BODY = 'body',
  QUERY = 'query',
  PARAM = 'param',
  HEADERS = 'headers',
  REQUEST = 'request',
  IP = 'ip',
  COOKIE = 'cookie',
  RAW_BODY = 'raw_body',
}

export enum Scope {
  SINGLETON = 'singleton',
  TRANSIENT = 'transient',
  REQUEST = 'request',
}
