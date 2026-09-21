/**
 * Derived OpenAPI operationIds/summaries and route names per verb — ported
 * from the previous bridge's SLOT_NAMING so generated clients keep stable,
 * friendly names (`listUsers`, `getUser`, `rollbackDocumentVersion`, ...).
 */

import type { CrudEndpointName } from './verb-table';

const SLOT_NAMING: Partial<
  Record<CrudEndpointName, { verb: string; plural: boolean; suffix?: string; summaryNoun?: string }>
> = {
  create: { verb: 'create', plural: false },
  list: { verb: 'list', plural: true },
  read: { verb: 'get', plural: false },
  update: { verb: 'update', plural: false },
  delete: { verb: 'delete', plural: false },
  restore: { verb: 'restore', plural: false },
  upsert: { verb: 'upsert', plural: false },
  clone: { verb: 'clone', plural: false },
  search: { verb: 'search', plural: true },
  aggregate: { verb: 'aggregate', plural: true },
  export: { verb: 'export', plural: true },
  import: { verb: 'import', plural: true },
  bulkPatch: { verb: 'bulkPatch', plural: true },
  batchCreate: { verb: 'bulkCreate', plural: true },
  batchUpdate: { verb: 'bulkUpdate', plural: true },
  batchDelete: { verb: 'bulkDelete', plural: true },
  batchRestore: { verb: 'bulkRestore', plural: true },
  batchUpsert: { verb: 'bulkUpsert', plural: true },
  versionHistory: { verb: 'list', plural: false, suffix: 'Versions', summaryNoun: 'versions' },
  versionRead: { verb: 'get', plural: false, suffix: 'Version', summaryNoun: 'version' },
  versionCompare: { verb: 'compare', plural: false, suffix: 'Versions', summaryNoun: 'versions' },
  versionRollback: { verb: 'rollback', plural: false, suffix: 'Version', summaryNoun: 'version' },
};

const isAsciiAlphanumeric = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/** Preserve generated names without retrying a separator suffix at every offset. */
export function pascalResourceName(value: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const separators = cursor;
    while (cursor < value.length && !isAsciiAlphanumeric(value.charCodeAt(cursor))) cursor++;
    if (cursor === value.length) {
      // Existing names retain punctuation that has no following word.
      parts.push(value.slice(separators));
      break;
    }
    parts.push(value.charAt(cursor).toUpperCase());
    const remainder = ++cursor;
    while (cursor < value.length && isAsciiAlphanumeric(value.charCodeAt(cursor))) cursor++;
    parts.push(value.slice(remainder, cursor));
  }
  return parts.join('');
}

// "bulkDelete" -> "Bulk delete"
const humanizeVerb = (verb: string): string => {
  const words = verb.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export interface VerbNaming {
  operationId: string;
  summary: string;
}

export function deriveVerbNaming(
  endpoint: CrudEndpointName,
  singular: string,
  plural: string,
): VerbNaming | undefined {
  const naming = SLOT_NAMING[endpoint];
  if (!naming) return undefined;
  const noun = naming.plural ? plural : singular;
  const operationId = `${naming.verb}${pascalResourceName(noun)}${naming.suffix ?? ''}`;
  const summary = naming.summaryNoun
    ? `${humanizeVerb(naming.verb)} ${singular} ${naming.summaryNoun}`
    : `${humanizeVerb(naming.verb)} ${naming.plural ? plural : `a ${singular}`}`;
  return { operationId, summary };
}

/** Route name for `urlFor`: `<resourceName>.<endpoint>` (`users.read`). */
export function deriveRouteName(resourceName: string, endpoint: CrudEndpointName): string {
  return `${resourceName}.${endpoint}`;
}
