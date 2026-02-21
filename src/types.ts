import type { GuardType } from '@velajs/vela';

export type CrudEndpointName =
  | 'create'
  | 'list'
  | 'read'
  | 'update'
  | 'delete';

export interface CrudConfig {
  /** MetaInput from hono-crud */
  meta: unknown;
  /** AdapterBundle from hono-crud (e.g. MemoryAdapters) */
  adapters: unknown;
  /** Include only these CRUD operations */
  only?: CrudEndpointName[];
  /** Exclude these CRUD operations */
  except?: CrudEndpointName[];
  /** Per-endpoint config passed to defineEndpoints */
  endpoints?: Record<string, unknown>;
}

export interface ResourceConfig extends CrudConfig {
  guards?: GuardType[];
}
