// Edge-safe disposal contract (mirrors stratal's). Precedence:
//   Symbol.asyncDispose > Symbol.dispose > .dispose()
// Symbol.asyncDispose/Symbol.dispose are resolved at runtime (they are not in
// the ES2022 lib the project targets), so nothing here depends on the
// esnext.disposable typings.

const ASYNC_DISPOSE: symbol | undefined = (Symbol as { asyncDispose?: symbol }).asyncDispose;
const SYNC_DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;

export interface Disposable {
  dispose?(): void | Promise<void>;
}

function asRecord(value: unknown): Record<PropertyKey, unknown> | undefined {
  if (value === null) return undefined;
  return typeof value === 'object' || typeof value === 'function'
    ? (value as Record<PropertyKey, unknown>)
    : undefined;
}

export function isDisposable(value: unknown): boolean {
  const obj = asRecord(value);
  if (!obj) return false;
  if (ASYNC_DISPOSE && typeof obj[ASYNC_DISPOSE] === 'function') return true;
  if (SYNC_DISPOSE && typeof obj[SYNC_DISPOSE] === 'function') return true;
  return typeof obj.dispose === 'function';
}

export async function disposeInstance(value: unknown): Promise<void> {
  const obj = asRecord(value);
  if (!obj) return;
  if (ASYNC_DISPOSE && typeof obj[ASYNC_DISPOSE] === 'function') {
    await (obj[ASYNC_DISPOSE] as () => void | Promise<void>).call(obj);
    return;
  }
  if (SYNC_DISPOSE && typeof obj[SYNC_DISPOSE] === 'function') {
    (obj[SYNC_DISPOSE] as () => void).call(obj);
    return;
  }
  if (typeof obj.dispose === 'function') {
    await (obj.dispose as () => void | Promise<void>).call(obj);
  }
}
