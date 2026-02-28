import { METADATA_KEYS, Scope } from '../constants';
import { defineMetadata, getMetadata } from '../metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { InjectableOptions, InjectMetadata, Token } from './types';
import { ForwardRef } from './types';

export function Injectable(options: InjectableOptions = {}): ClassDecorator {
  return (target: object) => {
    const { scope = Scope.SINGLETON } = options;
    MetadataRegistry.markInjectable(target);
    MetadataRegistry.setScope(target, scope);
    // Keep WeakMap write for external package compat
    defineMetadata(METADATA_KEYS.INJECTABLE, true, target);
    defineMetadata(METADATA_KEYS.SCOPE, scope, target);
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
    defineMetadata(METADATA_KEYS.INJECT, existing, target);
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
    defineMetadata(METADATA_KEYS.INJECT, existing, target);
  };
}

export function isInjectable(target: object): boolean {
  return MetadataRegistry.hasInjectable(target) ||
    getMetadata<boolean>(METADATA_KEYS.INJECTABLE, target) === true;
}

export function getScope(target: object): Scope {
  return MetadataRegistry.getScope(target) ??
    getMetadata<Scope>(METADATA_KEYS.SCOPE, target) ??
    Scope.SINGLETON;
}

export function getConstructorDependencies(target: object): unknown[] {
  return (Reflect.getMetadata('design:paramtypes', target) as unknown[]) || [];
}

export function getInjectMetadata(target: object): InjectMetadata[] {
  return MetadataRegistry.getInjectTokens(target) ??
    getMetadata<InjectMetadata[]>(METADATA_KEYS.INJECT, target) ??
    [];
}
