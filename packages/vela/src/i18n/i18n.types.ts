export interface II18nService {
  /** Translate `key` (dot-path into the message tree) with optional ICU params. */
  t(key: string, params?: Record<string, unknown>): string;
  /** The resolved locale for the current request. */
  getLocale(): string;
}
