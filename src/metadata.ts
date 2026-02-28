// Lightweight metadata store — replaces the `reflect-metadata` npm package.
// All custom vela:* keys go through defineMetadata/getMetadata.
// The Reflect.metadata polyfill keeps SWC's auto-emitted design:paramtypes working.

declare global {
  namespace Reflect {
    function defineMetadata(key: string, value: unknown, target: object, propertyKey?: string | symbol): void;
    function getMetadata(key: string, target: object, propertyKey?: string | symbol): unknown;
    function getOwnMetadata(key: string, target: object, propertyKey?: string | symbol): unknown;
    function metadata(key: string, value: unknown): (target: object, propertyKey?: string | symbol) => void;
  }
}

const store = new WeakMap<object, Map<string, unknown>>();

function compositeKey(key: string, prop?: string | symbol): string {
  return prop !== undefined ? `${key}\0${String(prop)}` : key;
}

export function defineMetadata(key: string, value: unknown, target: object, propertyKey?: string | symbol): void {
  let map = store.get(target);
  if (!map) {
    map = new Map();
    store.set(target, map);
  }
  map.set(compositeKey(key, propertyKey), value);
}

export function getMetadata<T = unknown>(key: string, target: object, propertyKey?: string | symbol): T | undefined {
  return store.get(target)?.get(compositeKey(key, propertyKey)) as T | undefined;
}

// Minimal Reflect polyfill so the compiler's `Reflect.metadata(...)` calls work.
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
