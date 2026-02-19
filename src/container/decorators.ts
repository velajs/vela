import 'reflect-metadata';
import { METADATA_KEYS, Scope } from '../constants.js';
import type { InjectableOptions, InjectMetadata, Token } from './types.js';

export function Injectable(options: InjectableOptions = {}): ClassDecorator {
  return (target: object) => {
    const { scope = Scope.SINGLETON } = options;
    Reflect.defineMetadata(METADATA_KEYS.INJECTABLE, true, target);
    Reflect.defineMetadata(METADATA_KEYS.SCOPE, scope, target);
  };
}

export function Inject(token: Token): ParameterDecorator {
  return (target: object, _propertyKey: string | symbol | undefined, parameterIndex: number) => {
    const existingMetadata: InjectMetadata[] =
      Reflect.getMetadata(METADATA_KEYS.INJECT, target) || [];

    existingMetadata.push({
      index: parameterIndex,
      token,
    });

    Reflect.defineMetadata(METADATA_KEYS.INJECT, existingMetadata, target);
  };
}

export function isInjectable(target: object): boolean {
  return Reflect.getMetadata(METADATA_KEYS.INJECTABLE, target) === true;
}

export function getScope(target: object): Scope {
  return Reflect.getMetadata(METADATA_KEYS.SCOPE, target) ?? Scope.SINGLETON;
}

export function getConstructorDependencies(target: object): unknown[] {
  return Reflect.getMetadata('design:paramtypes', target) || [];
}

export function getInjectMetadata(target: object): InjectMetadata[] {
  return Reflect.getMetadata(METADATA_KEYS.INJECT, target) || [];
}
