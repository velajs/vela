// Expand path-template variables in a disk root / key. Supported tokens:
//   {date}  → YYYY-MM-DD    {year} → YYYY    {month} → MM    {day} → DD
//   {uuid}  → crypto.randomUUID()
// `now` is injectable for deterministic tests.
export function expandPathTemplate(template: string, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear().toString();
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = now.getUTCDate().toString().padStart(2, '0');
  return template
    .replace(/\{date\}/g, `${yyyy}-${mm}-${dd}`)
    .replace(/\{year\}/g, yyyy)
    .replace(/\{month\}/g, mm)
    .replace(/\{day\}/g, dd)
    .replace(/\{uuid\}/g, () => crypto.randomUUID());
}

/**
 * Join a (templated) root with a relative path into a storage key. Segments are
 * sanitized: `.`, `..`, and empty segments are dropped, so a caller-supplied
 * `relativePath` containing `..` can never traverse above the disk root (a real
 * hazard for the presign proxy, where the key flows through `new URL()` which
 * would otherwise normalize `..`). Backslashes are treated as separators too.
 */
export function joinStoragePath(root: string | undefined, relativePath: string, now?: Date): string {
  const expandedRoot = root ? expandPathTemplate(root, now) : '';
  return `${expandedRoot}/${relativePath}`
    .split(/[/\\]+/)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
}
