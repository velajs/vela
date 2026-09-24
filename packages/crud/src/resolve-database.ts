import { missingDefaultAdapter } from './missing-adapter';
import type { InjectionToken } from '@velajs/vela';
import type { Container } from '@velajs/vela/module-kit';
import {
  CRUD_DATABASES,
  CRUD_DEFAULT_ADAPTER,
  CRUD_DEFAULT_AUDIT_STORE,
  CRUD_DEFAULT_VERSIONING_STORE,
} from './crud.tokens';
import type { CrudDatabaseRegistry } from './databases';
import type { RuntimeAdapter } from './adapter/contract';
import type { AuditStore } from './audit/index';
import type { VersioningStore } from './versioning/index';
import type { RuntimeCrudConfig } from './crud.types';
import { ConfigurationException } from './envelope/errors';

async function optional<T>(container: Container, token: InjectionToken<T>): Promise<T | undefined> {
  return container.has(token) ? container.resolveAsync(token) : undefined;
}

type Registration = { name: string; identity: object };
type Resolved = RuntimeCrudConfig & { adapter: RuntimeAdapter };

function named(
  config: RuntimeCrudConfig,
  registry: CrudDatabaseRegistry | undefined,
  registration?: Registration,
): Resolved | undefined {
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
      versioningStore: config.versioningStore
        ? registry.bindStore(name, config.versioningStore)
        : database.versioningStore,
      auditStore: config.auditStore
        ? registry.bindStore(name, config.auditStore)
        : database.auditStore,
    };
  }
  if (config.databaseResource)
    throw new ConfigurationException('databaseResource requires a selected database');
  return undefined;
}
function defaults(
  config: RuntimeCrudConfig,
  adapter: RuntimeAdapter | undefined,
  versioningStore?: VersioningStore,
  auditStore?: AuditStore,
): Resolved {
  if (!adapter || adapter === missingDefaultAdapter.runtime)
    throw new ConfigurationException(
      'No adapter — pass adapter on the resource or import CrudModule.forRoot({ adapter })',
    );
  return {
    ...config,
    adapter,
    versioningStore: config.versioningStore ?? versioningStore,
    auditStore: config.auditStore ?? auditStore,
  };
}

/** Shared HTTP/headless resolution. Named databases never borrow a different database's stores. */
export async function resolveCrudDatabase(
  container: Container,
  config: RuntimeCrudConfig,
  registration?: Registration,
): Promise<Resolved> {
  const selected = named(config, await optional(container, CRUD_DATABASES), registration);
  if (selected) return selected;
  return defaults(
    config,
    config.adapter ?? (await optional(container, CRUD_DEFAULT_ADAPTER))?.runtime,
    config.versioningStore ?? (await optional(container, CRUD_DEFAULT_VERSIONING_STORE)),
    config.auditStore ?? (await optional(container, CRUD_DEFAULT_AUDIT_STORE)),
  );
}

/** Synchronous discovery after provider initialization. Unresolved async providers fail closed. */
export function resolveCrudDatabaseSync(
  container: Container,
  config: RuntimeCrudConfig,
  registration?: Registration,
): Resolved {
  const optionalSync = <T>(token: InjectionToken<T>): T | undefined =>
    container.has(token) ? container.resolve(token) : undefined;
  const selected = named(config, optionalSync(CRUD_DATABASES), registration);
  if (selected) return selected;
  return defaults(
    config,
    config.adapter ?? optionalSync(CRUD_DEFAULT_ADAPTER)?.runtime,
    config.versioningStore ?? optionalSync(CRUD_DEFAULT_VERSIONING_STORE),
    config.auditStore ?? optionalSync(CRUD_DEFAULT_AUDIT_STORE),
  );
}
