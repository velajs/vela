export type {
  AccessClaims,
  AccessKeySet,
  GroupRoleMapping,
  IssuerPreset,
  PrincipalType,
  RequestVerifyOptions,
  ResolvedIdentity,
  ResolveIdentity,
  VerifyAccessJwtOptions,
} from './types';

export type { GenericOidcConfig } from './issuer';
export { cloudflareAccessIssuer, genericOidcIssuer } from './issuer';

export { readToken } from './read-token';

export { assertVerifyOptions, normalizeAudiences, verifyAccessJwt, verifyRequest } from './verify';

export { JWKS_CACHE_MAX, clearJwksCache, getRemoteJwks, jwksCacheSize } from './jwks-cache';

export type {
  DefineIdentitySpec,
  IdentityContract,
  IdentityValidation,
  InferIdentity,
  OnInvalidMode,
} from './identity-contract';
export { defineIdentity } from './identity-contract';

export type {
  InferStandardOutput,
  StandardIssue,
  StandardProps,
  StandardResult,
  StandardSchemaV1,
} from './standard-schema';

export type { CreateAccessResolverOptions } from './resolver';
export {
  composeResolvers,
  createAccessResolver,
  IdentityRejectedError,
  rolesFromGroups,
} from './resolver';
