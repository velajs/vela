/** How the request locale is detected. */
export type DetectionStrategy = 'header' | 'query' | 'cookie';

export interface I18nModuleOptions {
  /** Default locale. @default 'en' */
  defaultLocale?: string;
  /** Fallback when a translation is missing. @default defaultLocale */
  fallbackLocale?: string;
  /** Supported locales; request locales outside this list fall back to default. @default ['en'] */
  locales?: string[];
  /** Locale detection config. */
  detection?: {
    /** Set false to disable detection (always use defaultLocale). @default true */
    enabled?: boolean;
    /** @default 'header' (Accept-Language) */
    strategy?: DetectionStrategy;
    /** Cookie/query parameter name. @default 'locale' */
    lookupKey?: string;
  };
}

export interface ResolvedI18nOptions {
  defaultLocale: string;
  fallbackLocale: string;
  locales: string[];
  detection: { enabled: boolean; strategy: DetectionStrategy; lookupKey: string };
}

export function resolveI18nOptions(options?: I18nModuleOptions): ResolvedI18nOptions {
  const detection = options?.detection;
  const defaultLocale = options?.defaultLocale ?? 'en';
  return {
    defaultLocale,
    fallbackLocale: options?.fallbackLocale ?? defaultLocale,
    locales: options?.locales ?? ['en'],
    detection: {
      enabled: detection?.enabled !== false,
      strategy: detection?.strategy ?? 'header',
      lookupKey: detection?.lookupKey ?? 'locale',
    },
  };
}
