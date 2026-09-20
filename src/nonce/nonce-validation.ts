const encoder = new TextEncoder();
export const MAX_NONCE_BYTES = 512;
export function isCanonicalBoundedText(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string') return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || codePoint === 0x7f || (codePoint >= 0xd800 && codePoint <= 0xdfff))
    ) {
      return false;
    }
  }
  return value.length > 0 && value === value.trim() && encoder.encode(value).byteLength <= maxBytes;
}

export function isValidExpiry(
  expEpochSeconds: unknown,
  nowEpochSeconds: number,
): expEpochSeconds is number {
  return (
    typeof expEpochSeconds === 'number' &&
    Number.isSafeInteger(expEpochSeconds) &&
    expEpochSeconds > 0 &&
    expEpochSeconds >= nowEpochSeconds
  );
}
