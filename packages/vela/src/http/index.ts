export { DEFAULT_BODY_LIMIT_BYTES, RouteManager } from './route.manager';
export type { RouteManagerOptions } from './route.manager';
export type { GuardPhase } from '../pipeline/guard-phase';
export {
  DEFAULT_QUERY_BYTES_LIMIT,
  DEFAULT_QUERY_DEPTH_LIMIT,
  DEFAULT_QUERY_PARAMETER_LIMIT,
  shouldWarnProductionSecurity,
  warnRelaxedSecurityLimit,
} from './security-options';
export type {
  VelaSecurityOptions,
  VelaBodySecurityOptions,
  VelaBodyLimitOverride,
  VelaQuerySecurityOptions,
} from './security-options';
export type { CorsOptions } from './cors';
export { MiddlewareBuilder } from '../module/middleware';
export type {
  MiddlewareConsumer,
  MiddlewareConfigProxy,
  RouteInfo,
  NestModule,
  MiddlewareRouteDefinition,
} from '../module/middleware';
export {
  Controller,
  Version,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Options,
  Head,
  All,
  Param,
  Query,
  Body,
  Headers,
  Req,
  Ctx,
  Res,
  Ip,
  Cookie,
  Cookies,
  RawBody,
  HttpCode,
  Header,
  Redirect,
  createParamDecorator,
  applyDecorators,
  isController,
} from './decorators';
export type { RouteOptions, SchemaParamDecorator } from './decorators';
export { Sse } from './sse';
export type { MessageEvent, SseResult } from './sse';
export { VERSION_NEUTRAL } from './version';
export type { RouteVersion, VersionValue } from './version';
export type { GlobalPrefixOptions, RoutePathOptions, VersioningOptions } from './route-paths';
export { createLazyParamDecorator } from './lazy-param.decorator';
export { readJsonBody } from './json-body';
export type { ReadJsonBodyOptions } from './json-body';

// Named-route URL generation + signed URLs
export { UrlGeneratorService, SignedUrlGuard, SignedUrl, URL_SIGNING_SECRET } from './url/index';
export type { UrlForOptions, SignedUrlGenerateOptions } from './url/index';
export type { VelaRouteMap, RouteName, RouteParams } from './route-map';
export { enableAmbientContainer, getCurrentContainer, getCurrentRequestContext } from './ambient';
export type {
  RouteMetadata,
  ControllerMetadata,
  ControllerOptions,
  ParamMetadata,
  ControllerRegistration,
} from './types';
