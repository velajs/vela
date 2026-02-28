import { METADATA_KEYS, Scope } from '../constants';
import { defineMetadata, getMetadata } from '../metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import type { InjectableOptions, InjectMetadata, Token } from './types';

export function Injectable(options: InjectableOptions = {}): ClassDecorator {
  return (target: object) => {
    const { scope = Scope.SINGLETON } = options;
    MetadataRegistry.markInjectable(target as Constructor);
    MetadataRegistry.setScope(target as Constructor, scope);
    // Keep WeakMap write for external package compat
    defineMetadata(METADATA_KEYS.INJECTABLE, true, target);
    defineMetadata(METADATA_KEYS.SCOPE, scope, target);
  };
}

export function Optional(): ParameterDecorator {
  return (target: object, _propertyKey: string | symbol | undefined, parameterIndex: number) => {
    const existing: InjectMetadata[] =
      MetadataRegistry.getInjectTokens(target as Constructor) ??
      (getMetadata(METADATA_KEYS.INJECT, target) as InjectMetadata[] || []);

    const entry = existing.find((m) => m.index === parameterIndex);
    if (entry) {
      entry.optional = true;
    } else {
      existing.push({ index: parameterIndex, optional: true });
    }

    MetadataRegistry.setInjectTokens(target as Constructor, existing);
    defineMetadata(METADATA_KEYS.INJECT, existing, target);
  };
}

export function Inject(token: Token): ParameterDecorator {
  return (target: object, _propertyKey: string | symbol | undefined, parameterIndex: number) => {
    const existing: InjectMetadata[] =
      MetadataRegistry.getInjectTokens(target as Constructor) ??
      (getMetadata(METADATA_KEYS.INJECT, target) as InjectMetadata[] || []);

    existing.push({
      index: parameterIndex,
      token,
    });

    MetadataRegistry.setInjectTokens(target as Constructor, existing);
    defineMetadata(METADATA_KEYS.INJECT, existing, target);
  };
}

export function isInjectable(target: object): boolean {
  return MetadataRegistry.hasInjectable(target as Constructor) ||
    getMetadata(METADATA_KEYS.INJECTABLE, target) === true;
}

export function getScope(target: object): Scope {
  return MetadataRegistry.getScope(target as Constructor) ??
    (getMetadata(METADATA_KEYS.SCOPE, target) as Scope) ?? Scope.SINGLETON;
}

export function getConstructorDependencies(target: object): unknown[] {
  return (Reflect.getMetadata('design:paramtypes', target) as unknown[]) || [];
}

export function getInjectMetadata(target: object): InjectMetadata[] {
  return MetadataRegistry.getInjectTokens(target as Constructor) ??
    (getMetadata(METADATA_KEYS.INJECT, target) as InjectMetadata[] || []);
}
