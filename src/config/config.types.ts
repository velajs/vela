export interface ConfigModuleOptions<T extends Record<string, unknown> = Record<string, unknown>> {
  config: T;
  validate?: (config: T) => T;
}
