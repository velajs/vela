import { METADATA_KEYS, Scope } from '../constants';
import { defineMetadata, getMetadata } from '../metadata';
import type { InjectableOptions, InjectMetadata, Token } from './types';

export function Injectable(options: InjectableOptions = {}): ClassDecorator {
  return (target: object) => {
    const { scope = Scope.SINGLETON } = options;
    defineMetadata(METADATA_KEYS.INJECTABLE, true, target);
    defineMetadata(METADATA_KEYS.SCOPE, scope, target);
  };
}

export function Inject(token: Token): ParameterDecorator {
  return (target: object, _propertyKey: string | symbol | undefined, parameterIndex: number) => {
    const existingMetadata: InjectMetadata[] =
      getMetadata(METADATA_KEYS.INJECT, target) as InjectMetadata[] || [];

    existingMetadata.push({
      index: parameterIndex,
      token,
    });

    defineMetadata(METADATA_KEYS.INJECT, existingMetadata, target);
  };
}

export function isInjectable(target: object): boolean {
  return getMetadata(METADATA_KEYS.INJECTABLE, target) === true;
}

export function getScope(target: object): Scope {
  return (getMetadata(METADATA_KEYS.SCOPE, target) as Scope) ?? Scope.SINGLETON;
}

export function getConstructorDependencies(target: object): unknown[] {
  return (Reflect.getMetadata('design:paramtypes', target) as unknown[]) || [];
}

export function getInjectMetadata(target: object): InjectMetadata[] {
  return getMetadata(METADATA_KEYS.INJECT, target) as InjectMetadata[] || [];
}
