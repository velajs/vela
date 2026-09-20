// Single home for path manipulation. Used by route building, openapi docs,
// and decorator metadata.

export function normalizePath(path: string): string {
  if (!path) return path;
  return path.startsWith('/') ? path : `/${path}`;
}

export function joinPaths(prefix: string, path: string): string {
  const cleanPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const cleanPath = path && !path.startsWith('/') ? `/${path}` : path;
  return `${cleanPrefix}${cleanPath}` || '/';
}

// Convert ':id' Hono syntax to '{id}' OpenAPI syntax.
export function toOpenApiPath(path: string): string {
  return path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
}
