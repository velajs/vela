// Every public entry imports this module, so each emitted declaration file
// carries the augmentation, whichever entry an application imports.
declare module '@velajs/vela' {
  /**
   * On Workers the framework ENV is the native environment: the bindings,
   * variables and secrets `wrangler types` declares on `Cloudflare.Env`.
   */
  interface VelaEnv extends Cloudflare.Env {}
}

export {};
