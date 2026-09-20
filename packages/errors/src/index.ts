export { VelaError } from './error';
export type { VelaErrorOptions } from './error';

export { CORE_ENTRIES } from './catalog-data';
export type { CoreErrorCode, ErrorCatalogEntry } from './catalog-data';

export { CORE_CATALOG, STATUS_TO_CODE, composeCatalogs, defineErrorCatalog } from './catalog';
export type { Catalog } from './catalog';

export { isVelaError } from './guard';
export type { VelaErrorLike } from './guard';

export { toErrorBody } from './to-error-body';
export type { ErrorBodyResult, ToErrorBodyOptions, WireErrorObject } from './to-error-body';

export { invariant, unreachable } from './invariant';
