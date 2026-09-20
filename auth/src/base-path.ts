export const DEFAULT_BETTER_AUTH_BASE_PATH = '/api/auth';

/** Validate and canonicalize the route prefix used by the public auth controller. */
export function normalizeBetterAuthBasePath(value?: string): string {
  const basePath = value ?? DEFAULT_BETTER_AUTH_BASE_PATH;
  if (
    basePath.length === 0 ||
    basePath !== basePath.trim() ||
    !basePath.startsWith('/') ||
    basePath.startsWith('//') ||
    basePath === '/' ||
    basePath.endsWith('/') ||
    /[\\?#*]/u.test(basePath) ||
    /%(?:2e|2f|5c)/iu.test(basePath)
  ) {
    throw new Error(
      '@velajs/better-auth: basePath must be a canonical absolute path such as "/api/auth"',
    );
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(basePath);
  } catch {
    throw new Error('@velajs/better-auth: basePath contains invalid percent encoding');
  }
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('@velajs/better-auth: basePath must not contain dot segments');
  }
  return basePath;
}
