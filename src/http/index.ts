export { RouteManager } from './route.manager';
export type { RouteManagerOptions } from './route.manager';
export { MiddlewareBuilder } from '../module/middleware';
export type { MiddlewareConsumer, MiddlewareConfigProxy, RouteInfo, NestModule, MiddlewareRouteDefinition } from '../module/middleware';
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
  Sse,
  Param,
  Query,
  Body,
  Headers,
  Req,
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
export type { RouteOptions } from './decorators';
export { createLazyParamDecorator } from './lazy-param.decorator';

// Named-route URL generation + signed URLs
export {
  UrlGeneratorService,
  SignedUrlGuard,
  SignedUrl,
  URL_SIGNING_SECRET,
} from './url/index';
export type { UrlForOptions, SignedUrlGenerateOptions } from './url/index';
export type { VelaRouteMap, RouteName, RouteParams } from './route-map';
export {
  enableAmbientContainer,
  getCurrentContainer,
  getCurrentRequestContext,
} from './ambient';
export type {
  RouteMetadata,
  ControllerMetadata,
  ControllerOptions,
  ParamMetadata,
  ControllerRegistration,
} from './types';
