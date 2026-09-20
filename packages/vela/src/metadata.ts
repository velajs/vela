// Single funnel: every Reflect.* metadata write/read routes into MetadataRegistry.
// SWC emits Reflect.metadata('design:paramtypes', ...) calls in compiled code;
// the polyfill catches those and parks them in the registry alongside vela's typed slots.

import { MetadataRegistry } from './registry/metadata.registry';

declare global {
  namespace Reflect {
    function defineMetadata(
      key: string,
      value: unknown,
      target: object,
      propertyKey?: string | symbol,
    ): void;
    function getMetadata(key: string, target: object, propertyKey?: string | symbol): unknown;
    function getOwnMetadata(key: string, target: object, propertyKey?: string | symbol): unknown;
    function metadata(
      key: string,
      value: unknown,
    ): (target: object, propertyKey?: string | symbol) => void;
  }
}

export function defineMetadata(
  key: string,
  value: unknown,
  target: object,
  propertyKey?: string | symbol,
): void {
  MetadataRegistry.setReflectMetadata(target, key, value, propertyKey);
}

export function getMetadata<T = unknown>(
  key: string,
  target: object,
  propertyKey?: string | symbol,
): T | undefined {
  return MetadataRegistry.getReflectMetadata<T>(target, key, propertyKey);
}

if (typeof Reflect.defineMetadata !== 'function') {
  Reflect.defineMetadata = defineMetadata;
  Reflect.getMetadata = getMetadata;
  Reflect.getOwnMetadata = getMetadata;
  Reflect.metadata = (key: string, value: unknown) => {
    return (target: object, propertyKey?: string | symbol) => {
      defineMetadata(key, value, target, propertyKey);
    };
  };
}
