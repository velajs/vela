export const METADATA_KEYS = {
  // DI
  INJECTABLE: 'edgest:injectable',
  INJECT: 'edgest:inject',
  SCOPE: 'edgest:scope',

  // Module
  MODULE: 'edgest:module',

  // HTTP
  CONTROLLER: 'edgest:controller',
  ROUTES: 'edgest:routes',
  PARAMS: 'edgest:params',
  HTTP_CODE: 'edgest:http-code',
  RESPONSE_HEADERS: 'edgest:response-headers',
  REDIRECT: 'edgest:redirect',

  // Pipeline
  CATCH: 'edgest:catch',

  // CRUD
  CRUD: 'edgest:crud',
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
}

export enum Scope {
  SINGLETON = 'singleton',
  TRANSIENT = 'transient',
  REQUEST = 'request',
}
