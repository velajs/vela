/**
 * Barrel for the model-policy surface: the `ModelPolicies` / `PolicyContext`
 * contracts (`./types`) and the pure evaluators the kernel composes at the
 * read/write boundary (`./evaluate`).
 */

export type { ModelPolicies, PolicyContext } from './types';
export {
  canRead,
  canWrite,
  filterReadable,
  maskFields,
  pushdownConditions,
} from './evaluate';
