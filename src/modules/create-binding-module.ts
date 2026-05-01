import {
  createModuleRef,
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
export function createBindingModule<TService>(
  opts: CreateBindingModuleOptions<TService>,
): BindingModuleStatic {
  return {
    forRoot({ binding }: { binding: string }): DynamicModule {
      const ref = new BindingRef(binding);
      return {
        module: createModuleRef(`${opts.name}Module_${binding}`),
        providers: [
          { provide: opts.bindingRefToken, useValue: ref },
          opts.serviceClass,
        ],
        exports: [opts.serviceClass, opts.bindingRefToken],
      };
    },
  };
}
