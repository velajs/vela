import { Scope } from '../constants';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { InjectableOptions, InjectMetadata, Token } from './types';
import { ForwardRef } from './types';

export function Injectable(options: InjectableOptions = {}): ClassDecorator {
  return (target: object) => {
    const { scope = Scope.SINGLETON } = options;
    MetadataRegistry.markInjectable(target);
    MetadataRegistry.setScope(target, scope);
  };
}

export function Optional(): ParameterDecorator {
  return (target: object, _propertyKey: string | symbol | undefined, parameterIndex: number) => {
    const existing = getInjectMetadata(target);
    const entry = existing.find((m) => m.index === parameterIndex);
    if (entry) {
      entry.optional = true;
    } else {
      existing.push({ index: parameterIndex, optional: true });
    }
    MetadataRegistry.setInjectTokens(target, existing);
  };
}

export function Inject(token: Token | ForwardRef): ParameterDecorator {
  return (target: object, _propertyKey: string | symbol | undefined, parameterIndex: number) => {
    const existing = getInjectMetadata(target);
    const entry = existing.find((m) => m.index === parameterIndex);
    if (entry) {
      entry.token = token;
    } else {
      existing.push({ index: parameterIndex, token });
    }
    MetadataRegistry.setInjectTokens(target, existing);
  };
}

export function isInjectable(target: object): boolean {
  return MetadataRegistry.hasInjectable(target);
}

export function getScope(target: object): Scope {
  return MetadataRegistry.getScope(target) ?? Scope.SINGLETON;
}

/**
 * Read through Reflect so dist/src coexistence in tests routes through the
 * single polyfill-installed registry — SWC writes `design:paramtypes` via
 * Reflect, so reads must too. The runtime contract is that each entry is a
 * constructor reference (a `Token`); we surface that contract directly so
 * callers don't need to re-cast.
 */
export function getConstructorDependencies(target: object): Array<Token | undefined> {
  return (
    (Reflect.getMetadata('design:paramtypes', target) as Array<Token | undefined> | undefined) ?? []
  );
}

export function getInjectMetadata(target: object): InjectMetadata[] {
  return MetadataRegistry.getInjectTokens(target) ?? [];
}
