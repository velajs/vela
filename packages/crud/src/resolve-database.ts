import type { Container, InjectionToken } from '@velajs/vela';
import {
  CRUD_DATABASES,
  CRUD_DEFAULT_ADAPTER,
  CRUD_DEFAULT_AUDIT_STORE,
  CRUD_DEFAULT_VERSIONING_STORE,
} from './crud.tokens';
import type { RuntimeCrudConfig } from './crud.types';
import { ConfigurationException } from './envelope/errors';

async function optional<T>(container: Container, token: InjectionToken<T>): Promise<T | undefined> {
  return container.has(token) ? container.resolveAsync(token) : undefined;
}

/** Shared HTTP/headless resolution. Named databases never borrow a different database's stores. */
export async function resolveCrudDatabase(
  container: Container,
  config: RuntimeCrudConfig,
  registration?: { name: string; identity: object },
): Promise<RuntimeCrudConfig & { adapter: NonNullable<RuntimeCrudConfig['adapter']> }> {
  const registry = await optional(container, CRUD_DATABASES);
  const name = config.database ?? (config.adapter ? undefined : registry?.defaultDatabase);
  if (name !== undefined) {
    if (config.adapter)
      throw new ConfigurationException(
        'Choose either a named database or an explicit resource adapter',
      );
    if (!registry) throw new ConfigurationException(`Unknown database binding '${name}'`);
    const database = registry.resolve(name);
    const key = config.databaseResource ?? config.model.name;
    const resource = database.resources[key];
    if (!resource)
      throw new ConfigurationException(`Unknown resource '${key}' in database '${name}'`);
    if (resource.model !== config.model)
      throw new ConfigurationException(
        `Resource '${key}' uses a different model in database '${name}'`,
      );
    if (registration) registry.registerResource(name, registration.name, registration.identity);
    return {
      ...config,
      database: name,
      adapter: resource.adapter.runtime,
      versioningStore: config.versioningStore ?? database.versioningStore,
      auditStore: config.auditStore ?? database.auditStore,
    };
  }
  if (config.databaseResource)
    throw new ConfigurationException('databaseResource requires a selected database');
  const adapter = config.adapter ?? (await optional(container, CRUD_DEFAULT_ADAPTER))?.runtime;
  if (!adapter)
    throw new ConfigurationException(
      'No adapter — pass adapter on the resource or import CrudModule.forRoot({ adapter })',
    );
  return {
    ...config,
    adapter,
    versioningStore:
      config.versioningStore ?? (await optional(container, CRUD_DEFAULT_VERSIONING_STORE)),
    auditStore: config.auditStore ?? (await optional(container, CRUD_DEFAULT_AUDIT_STORE)),
  };
}
