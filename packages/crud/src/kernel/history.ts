import type { HistoryStoreContext } from '../versioning/index';
import type { TransactionStoreBinding } from './transaction';
import { ConfigurationException } from '../envelope/errors';
import type { RuntimeResourceConfig } from './resource';

/** Validate before opening a transaction or invoking mutation hooks. */
export function assertHistoryPersistence(config: RuntimeResourceConfig): void {
  const bindings = [
    ...(config.model.versioning ? [config.versioningStore?.transaction] : []),
    ...(config.auditPersistence?.mode === 'transaction' ? [config.auditStore?.transaction] : []),
  ];
  if (config.auditPersistence?.mode === 'transaction' && !config.model.audit)
    throw new ConfigurationException('Transactional audit requires model.audit');
  for (const binding of bindings) {
    if (
      !config.adapter.capabilities.has('transactions') ||
      !binding ||
      typeof binding.bind !== 'function' ||
      !config.adapter.transactionOwner ||
      binding.owner !== config.adapter.transactionOwner
    )
      throw new ConfigurationException(
        'History persistence requires a transaction-aware store on the exact same database owner',
      );
  }
}

export function needsHistoryTransaction(config: RuntimeResourceConfig): boolean {
  return !!config.model.versioning || config.auditPersistence?.mode === 'transaction';
}

/** Applied only by the engine for a model without tenant ownership. The outer
 * CRUD admission check still uses the original authenticated transaction tenant.
 */
export function globalHistoryBinding<Store>(
  binding: TransactionStoreBinding<Store>,
): TransactionStoreBinding<Store> {
  return {
    owner: binding.owner,
    bind(scope, context, observer) {
      const historyContext: HistoryStoreContext = { ...context, historyNamespace: 'global' };
      return binding.bind(scope, historyContext, observer);
    },
  };
}
