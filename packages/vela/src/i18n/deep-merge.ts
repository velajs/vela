/** Deep-merge two message trees; source overrides target at the leaf level. */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    const targetValue = Object.hasOwn(target, key) ? target[key] : undefined;
    const sourceValue = source[key];

    const mergeObjects =
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue) &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue);
    Object.defineProperty(result, key, {
      value: mergeObjects
        ? deepMerge(targetValue as Record<string, unknown>, sourceValue as Record<string, unknown>)
        : sourceValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return result;
}
