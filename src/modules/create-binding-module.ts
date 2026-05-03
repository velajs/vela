import {
  type DynamicModule,
  type InjectionToken,
  type Type,
} from '@velajs/vela';
import { BindingRef } from '../binding-ref';

interface CreateBindingModuleOptions<TService> {
  name: string;
  serviceClass: Type<TService>;
  bindingRefToken: InjectionToken<BindingRef>;
}

export interface BindingModuleStatic {
  forRoot(options: { binding: string }): DynamicModule;
}

// Single factory for every Cloudflare binding module (KV, D1, R2, ...).
// Each binding module is just a bag of (token, service); this generates
// the canonical forRoot() shape for them.
//
// Identity model (post vela audit #2):
//   - One real module class is declared per binding TYPE (KV, D1, R2, ...).
//     Its `name` property is set so error messages and diagnostics carry
//     the friendly name (e.g. `KVModule`).
//   - Each `forRoot({ binding })` returns `{ module, key: binding, ... }`.
//     Vela dedups by (module, key), so two `KVModule.forRoot({...})` calls
//     with different bindings coexist as distinct module instances; two
//     calls with the same binding dedup.
export function createBindingModule<TService>(
  opts: CreateBindingModuleOptions<TService>,
): BindingModuleStatic {
  // Fresh module class per binding TYPE (one KVModule, one D1Module, ...).
  // The computed-property-name idiom is the canonical JS way to give a
  // class expression a dynamic `name`: NamedEvaluation reads the property
  // key and stamps it on the class at creation, instead of patching the
  // (configurable, non-writable) `name` slot via Object.defineProperty.
  const className = `${opts.name}Module`;
  const moduleClass: Type = { [className]: class {} }[className];

  return {
    forRoot({ binding }: { binding: string }): DynamicModule {
      const ref = new BindingRef(binding);
      return {
        module: moduleClass,
        key: binding,
        providers: [
          { provide: opts.bindingRefToken, useValue: ref },
          opts.serviceClass,
        ],
        exports: [opts.serviceClass, opts.bindingRefToken],
      };
    },
  };
}
