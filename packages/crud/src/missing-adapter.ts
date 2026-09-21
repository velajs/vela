import type { CrudAdapter } from './adapter/contract';
import { ConfigurationException } from './envelope/errors';

async function missing(): Promise<never> {
  throw new ConfigurationException('No default adapter; select a named database');
}

/** Keeps the legacy non-optional token contract without an observable throwing getter. */
export const missingDefaultAdapter: Pick<CrudAdapter, 'runtime'> = Object.freeze({
  runtime: Object.freeze({
    capabilities: new Set<never>(),
    requestScope: missing,
    transaction: missing,
    create: missing,
    readOne: missing,
    update: missing,
    delete: missing,
    list: missing,
  }),
});
