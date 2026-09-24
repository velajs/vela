import { open } from 'node:fs/promises';

/** Configuration and snapshot inputs are small; a larger file is not one of them. */
export const MAX_INPUT_BYTES = 1024 * 1024;

/** Read a regular file of at most 1 MiB as UTF-8. */
export async function readInput(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error(`${path} must be a regular file.`);
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      // eslint-disable-next-line no-await-in-loop -- Each offset depends on the preceding partial read.
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_INPUT_BYTES) throw new Error(`${path} must not exceed 1 MiB.`);
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await file.close();
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
