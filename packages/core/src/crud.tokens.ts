/**
 * DI tokens. Per-resource tokens are memoized in a `globalThis`-anchored map
 * (queue-module pattern) so Vite HMR re-evaluation mints identical tokens and
 * `@Inject(crudResourceToken('users'))` keeps resolving across reloads.
 */

import { moduleToken, type InjectionToken } from '@velajs/vela';
import type { CrudAdapter } from './adapter/contract';
import type { CrudResource } from './kernel/resource';
import type { VersioningStore } from './versioning/index';
import type { AuditStore } from './audit/index';

/** The app-wide default adapter, provided by `CrudModule.forRoot`. */
export const CRUD_DEFAULT_ADAPTER: InjectionToken<CrudAdapter> = moduleToken<CrudAdapter>(
  'crud:default-adapter',
);

/** The app-wide default version-history store, provided by `CrudModule.forRoot`. */
export const CRUD_DEFAULT_VERSIONING_STORE: InjectionToken<VersioningStore> =
  moduleToken<VersioningStore>('crud:default-versioning-store');

/** The app-wide default audit-log store, provided by `CrudModule.forRoot`. */
export const CRUD_DEFAULT_AUDIT_STORE: InjectionToken<AuditStore> = moduleToken<AuditStore>(
  'crud:default-audit-store',
);

const RESOURCE_TOKENS = Symbol.for('velajs:crud:resource-tokens:v1');

function tokenStore(): Map<string, InjectionToken<CrudResource>> {
  const holder = globalThis as { [RESOURCE_TOKENS]?: Map<string, InjectionToken<CrudResource>> };
  holder[RESOURCE_TOKENS] ??= new Map();
  return holder[RESOURCE_TOKENS];
}

/** The compiled `CrudResource` for a named resource (forFeature registers it). */
export function crudResourceToken(name: string): InjectionToken<CrudResource> {
  const store = tokenStore();
  let token = store.get(name);
  if (!token) {
    token = moduleToken<CrudResource>(`crud:resource:${name}`);
    store.set(name, token);
  }
  return token;
}
