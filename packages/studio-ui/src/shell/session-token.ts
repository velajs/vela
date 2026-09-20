/**
 * Admin-token persistence. The master bearer token is kept in `sessionStorage`
 * (NOT `localStorage`): it is a powerful credential, so it must not survive a
 * browser restart — it lives only for the tab's session. The key is
 * studio-scoped to avoid colliding with a host app's storage.
 */

/** Studio-scoped sessionStorage key for the admin bearer token. */
export const STUDIO_TOKEN_STORAGE_KEY = 'vela-studio:admin-token';

function safeSessionStorage(): Storage | undefined {
  try {
    if (typeof globalThis !== 'undefined' && 'sessionStorage' in globalThis) {
      return globalThis.sessionStorage;
    }
  } catch {
    // Access can throw in sandboxed/embedded contexts; fall through.
  }
  return undefined;
}

export function readStoredToken(
  storage: Storage | undefined = safeSessionStorage(),
): string | undefined {
  try {
    return storage?.getItem(STUDIO_TOKEN_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredToken(
  token: string | undefined,
  storage: Storage | undefined = safeSessionStorage(),
): void {
  try {
    if (token === undefined) {
      storage?.removeItem(STUDIO_TOKEN_STORAGE_KEY);
    } else {
      storage?.setItem(STUDIO_TOKEN_STORAGE_KEY, token);
    }
  } catch {
    // Best-effort; storage may be unavailable.
  }
}
