import { CORE_ENTRIES, type CoreErrorCode, type ErrorCatalogEntry } from './catalog-data';
import { VelaError, type VelaErrorOptions } from './error';

export type { CoreErrorCode, ErrorCatalogEntry } from './catalog-data';
export { CORE_ENTRIES } from './catalog-data';

export interface Catalog<C extends string = string> {
  readonly entries: Readonly<Record<C, ErrorCatalogEntry>>;
  /** Typed thrower bound to this catalog's defaults. */
  error(code: C | (string & {}), options?: VelaErrorOptions): VelaError;
  has(code: string): boolean;
  get(code: string): ErrorCatalogEntry | undefined;
}

const makeCatalog = <C extends string>(
  entries: Readonly<Record<C, ErrorCatalogEntry>>,
): Catalog<C> => ({
  entries,
  error(code, options = {}) {
    const entry = (entries as Record<string, ErrorCatalogEntry>)[code];
    const hint = options.hint ?? entry?.hint;
    const docsUrl = options.docsUrl ?? entry?.docsUrl;
    return new VelaError(code, {
      ...options,
      status: options.status ?? entry?.status ?? 500,
      ...(hint === undefined ? {} : { hint }),
      ...(docsUrl === undefined ? {} : { docsUrl }),
    });
  },
  has: (code) => Object.hasOwn(entries, code),
  get: (code) =>
    Object.hasOwn(entries, code) ? (entries as Record<string, ErrorCatalogEntry>)[code] : undefined,
});

export const defineErrorCatalog = <const T extends Record<string, ErrorCatalogEntry>>(
  entries: T,
): Catalog<Extract<keyof T, string>> => makeCatalog(entries);

export const composeCatalogs = (...catalogs: Array<Catalog<string>>): Catalog<string> => {
  const merged: Record<string, ErrorCatalogEntry> = {};
  for (const catalog of catalogs) {
    for (const [code, entry] of Object.entries<ErrorCatalogEntry>(catalog.entries)) {
      if (Object.hasOwn(merged, code)) {
        throw new VelaError('internal', {
          message: `duplicate error code '${code}' while composing catalogs`,
        });
      }
      merged[code] = entry;
    }
  }
  return makeCatalog(merged);
};

export const CORE_CATALOG: Catalog<CoreErrorCode> = makeCatalog(CORE_ENTRIES);

export const STATUS_TO_CODE: Readonly<Record<number, CoreErrorCode>> = Object.fromEntries(
  (Object.entries(CORE_ENTRIES) as Array<[CoreErrorCode, ErrorCatalogEntry]>).map(([code, e]) => [
    e.status,
    code,
  ]),
) as Record<number, CoreErrorCode>;
