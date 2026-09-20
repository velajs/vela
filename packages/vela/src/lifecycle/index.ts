export interface OnModuleInit {
  onModuleInit(): void | Promise<void>;
}

export interface OnApplicationBootstrap {
  onApplicationBootstrap(): void | Promise<void>;
}

export interface OnModuleDestroy {
  onModuleDestroy(): void | Promise<void>;
}

export interface OnApplicationShutdown {
  onApplicationShutdown(signal?: string): void | Promise<void>;
}

export interface BeforeApplicationShutdown {
  beforeApplicationShutdown(signal?: string): void | Promise<void>;
}

export function hasOnModuleInit(instance: unknown): instance is OnModuleInit {
  return (
    instance !== null &&
    typeof instance === 'object' &&
    typeof (instance as OnModuleInit).onModuleInit === 'function'
  );
}

export function hasOnApplicationBootstrap(instance: unknown): instance is OnApplicationBootstrap {
  return (
    instance !== null &&
    typeof instance === 'object' &&
    typeof (instance as OnApplicationBootstrap).onApplicationBootstrap === 'function'
  );
}

export function hasOnModuleDestroy(instance: unknown): instance is OnModuleDestroy {
  return (
    instance !== null &&
    typeof instance === 'object' &&
    typeof (instance as OnModuleDestroy).onModuleDestroy === 'function'
  );
}

export function hasBeforeApplicationShutdown(
  instance: unknown,
): instance is BeforeApplicationShutdown {
  return (
    instance !== null &&
    typeof instance === 'object' &&
    typeof (instance as BeforeApplicationShutdown).beforeApplicationShutdown === 'function'
  );
}

export function hasOnApplicationShutdown(instance: unknown): instance is OnApplicationShutdown {
  return (
    instance !== null &&
    typeof instance === 'object' &&
    typeof (instance as OnApplicationShutdown).onApplicationShutdown === 'function'
  );
}
