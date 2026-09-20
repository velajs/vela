// Ported from @stratal/testing (MIT, © Temitayo Fadojutimi).

/**
 * Read the value at a dot-notation path (e.g. `data.user.id`).
 * Returns `undefined` when any segment along the way is null/undefined.
 */
export function getValueAtPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Whether a dot-notation path exists on the object, even when the value at the
 * path is `null`/`undefined`. Distinguishes "key present but null" from "key
 * absent".
 */
export function hasValueAtPath(obj: unknown, path: string): boolean {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return false;
    }

    if (typeof current !== 'object') {
      return false;
    }

    const record = current as Record<string, unknown>;

    if (!(part in record)) {
      return false;
    }

    current = record[part];
  }

  return true;
}
