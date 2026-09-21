import type { CrudAdapter } from './adapter/contract';
import type { Model } from './model/model.types';
import type { AuditStore } from './audit/index';
import type { VersioningStore } from './versioning/index';
import { ConfigurationException } from './envelope/errors';

export interface CrudDatabaseResource {
  readonly model: Model;
  readonly adapter: Pick<CrudAdapter, 'runtime'>;
}
export interface CrudDatabase<
  Name extends string = string,
  Handle = unknown,
  Resources extends Readonly<Record<string, CrudDatabaseResource>> = Readonly<
    Record<string, CrudDatabaseResource>
  >,
> {
  readonly name: Name;
  /** Original native handle: its driver/schema type is preserved. */
  readonly handle: Handle;
  readonly resources: Resources;
  readonly auditStore?: AuditStore;
  readonly versioningStore?: VersioningStore;
}

/** Describe one database using existing model-specific adapters. No connection is opened. */
export function defineCrudDatabase<
  const Name extends string,
  Handle,
  const Resources extends Readonly<Record<string, CrudDatabaseResource>>,
>(
  name: Name,
  options: Omit<CrudDatabase<Name, Handle, Resources>, 'name'>,
): CrudDatabase<Name, Handle, Resources> {
  if (!name.trim()) throw new ConfigurationException('Database name must not be empty');
  return Object.freeze({ ...options, name, resources: Object.freeze({ ...options.resources }) });
}

type Named<Databases extends readonly CrudDatabase[], Name extends Databases[number]['name']> =
  Extract<Databases[number], { readonly name: Name }> extends never
    ? CrudDatabase
    : Extract<Databases[number], { readonly name: Name }>;

/** Application-owned registry. Contains no ambient current database or tenant state. */
export class CrudDatabaseRegistry<
  Databases extends readonly CrudDatabase[] = readonly CrudDatabase[],
> {
  readonly #databases = new Map<string, CrudDatabase>();
  readonly #registrations = new Map<string, object>();
  readonly defaultDatabase: Databases[number]['name'] | undefined;

  constructor(databases: Databases, options: { defaultDatabase?: Databases[number]['name'] } = {}) {
    const stores = new Set<object>();
    for (const database of databases) {
      if (this.#databases.has(database.name))
        throw new ConfigurationException(`Duplicate database binding '${database.name}'`);
      for (const store of [database.auditStore, database.versioningStore]) {
        if (!store) continue;
        if (stores.has(store))
          throw new ConfigurationException('Database default stores must have separate instances');
        stores.add(store);
      }
      const owners = new Set(
        Object.values(database.resources).flatMap(({ adapter }) =>
          adapter.runtime.transactionOwner ? [adapter.runtime.transactionOwner] : [],
        ),
      );
      if (owners.size > 1)
        throw new ConfigurationException(
          `Database '${database.name}' contains adapters from different transaction owners`,
        );
      const tables = new Set(Object.values(database.resources).map(({ model }) => model.tableName));
      for (const [key, resource] of Object.entries(database.resources)) {
        if (!key.trim())
          throw new ConfigurationException('Database resource key must not be empty');
        for (const [relation, config] of Object.entries(resource.model.relations ?? {})) {
          if (config.target !== undefined && !tables.has(config.target))
            throw new ConfigurationException(
              `Database '${database.name}', resource '${key}': relation '${relation}' targets '${config.target}' outside this database; cross-database relations are unsupported`,
            );
        }
      }
      this.#databases.set(database.name, database);
    }
    this.defaultDatabase = options.defaultDatabase;
    if (this.defaultDatabase !== undefined) this.resolve(this.defaultDatabase);
  }

  get<Name extends Databases[number]['name']>(name: Name): Named<Databases, Name> {
    // The constructor builds the map exclusively from Databases. Exact name lookup
    // preserves that discriminated union after Map's intentional type erasure.
    return this.resolve(name) as Named<Databases, Name>;
  }

  /** Runtime selection for DI/config input; unknown names fail closed. */
  resolve(name: string): CrudDatabase {
    const database = this.#databases.get(name);
    if (!database) throw new ConfigurationException(`Unknown database binding '${name}'`);
    return database;
  }

  /** Each application gets its own registration claims even if it reuses configuration. */
  forApplication(): CrudDatabaseRegistry {
    const databases = [...this.#databases.values()].map((database): CrudDatabase => {
      const owner = Object.freeze({});
      return {
        ...database,
        resources: Object.fromEntries(
          Object.entries(database.resources).map(([key, resource]) => [
            key,
            {
              ...resource,
              adapter: {
                runtime: {
                  ...resource.adapter.runtime,
                  ...(resource.adapter.runtime.transactionOwner ? { transactionOwner: owner } : {}),
                },
              },
            },
          ]),
        ),
      };
    });
    return new CrudDatabaseRegistry<readonly CrudDatabase[]>(databases, {
      defaultDatabase: this.defaultDatabase,
    });
  }

  registerResource(database: string, name: string, registration: object): void {
    const key = JSON.stringify([database, name]);
    const previous = this.#registrations.get(key);
    if (previous && previous !== registration)
      throw new ConfigurationException(
        `Duplicate CRUD resource '${name}' in database '${database}'`,
      );
    this.#registrations.set(key, registration);
  }
}

export function createCrudDatabaseRegistry<const Databases extends readonly CrudDatabase[]>(
  databases: Databases,
  options: { defaultDatabase?: Databases[number]['name'] } = {},
): CrudDatabaseRegistry<Databases> {
  return new CrudDatabaseRegistry(databases, options);
}

/** Infer both the resource model and its database selection for forFeature/@Crud. */
export function databaseResource<
  Database extends CrudDatabase,
  Key extends keyof Database['resources'] & string,
>(
  database: Database,
  key: Key,
): {
  database: Database['name'];
  databaseResource: Key;
  model: Database['resources'][Key]['model'];
} {
  const resource = database.resources[key];
  if (!resource)
    throw new ConfigurationException(`Unknown resource '${key}' in database '${database.name}'`);
  return { database: database.name, databaseResource: key, model: resource.model };
}
