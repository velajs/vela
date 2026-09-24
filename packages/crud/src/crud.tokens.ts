/**
 * DI tokens. Per-resource tokens are memoized in a `globalThis`-anchored map
 * (queue-module pattern) so Vite HMR re-evaluation mints identical tokens and
 * `@Inject(crudResourceToken('users'))` keeps resolving across reloads.
 */

import { InjectionToken } from '@velajs/vela';
import type { CrudDatabaseRegistry } from './databases';
import type { CrudAdapter } from './adapter/contract';
import type { CrudResource } from './kernel/resource';
import type { VersioningStore } from './versioning/index';
import type { AuditStore } from './audit/index';

export const CRUD_DATABASES = new InjectionToken<CrudDatabaseRegistry | undefined>(
  'crud:databases',
);

/** The app-wide default adapter, provided by `CrudModule.forRoot`. */
export const CRUD_DEFAULT_ADAPTER = new InjectionToken<Pick<CrudAdapter, 'runtime'>>(
  'crud:default-adapter',
);

/** The app-wide default version-history store, provided by `CrudModule.forRoot`. */
export const CRUD_DEFAULT_VERSIONING_STORE: InjectionToken<VersioningStore | undefined> =
  new InjectionToken<VersioningStore | undefined>('crud:default-versioning-store');

/** The app-wide default audit-log store, provided by `CrudModule.forRoot`. */
export const CRUD_DEFAULT_AUDIT_STORE: InjectionToken<AuditStore | undefined> = new InjectionToken<
  AuditStore | undefined
>('crud:default-audit-store');

declare global {
  // The registry contains only tokens created by crudResourceToken. Declaring
  // its actual global slot keeps HMR identity without asserting unknown data.
  var __velajsCrudDatabaseResourceTokensV1: Map<string, InjectionToken<CrudResource>> | undefined;
  var __velajsCrudResourceTokensV1: Map<string, InjectionToken<CrudResource>> | undefined;
}

function tokenStore(): Map<string, InjectionToken<CrudResource>> {
  return (globalThis.__velajsCrudResourceTokensV1 ??= new Map());
}

/** The compiled `CrudResource` for a named resource (forFeature registers it). */
export function crudResourceToken(name: string, database?: string): InjectionToken<CrudResource> {
  const store =
    database === undefined
      ? tokenStore()
      : (globalThis.__velajsCrudDatabaseResourceTokensV1 ??= new Map());
  const key = database === undefined ? name : JSON.stringify([database, name]);
  let token = store.get(key);
  if (!token) {
    token = new InjectionToken<CrudResource>(`crud:resource:${key}`);
    store.set(key, token);
  }
  return token;
}
