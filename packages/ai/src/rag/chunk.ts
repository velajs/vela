/**
 * The zero-config chunker: slice `text` into windows of `size` characters that
 * overlap their neighbours by `overlap` characters. Deterministic and simple —
 * the default when {@link RagConfig.chunk} is not supplied. Swap in a
 * token-aware, sentence, or semantic splitter through that config hook.
 *
 * Leading/trailing whitespace is trimmed first; empty (or whitespace-only) input
 * yields no windows.
 */
export const fixedWindowChunks = (text: string, size: number, overlap: number): string[] => {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error('@velajs/ai/rag: chunk `size` must be a positive integer');
  }

  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new Error(
      '@velajs/ai/rag: chunk `overlap` must be a non-negative integer smaller than `size`',
    );
  }

  const body = text.trim();

  if (body.length === 0) {
    return [];
  }

  if (body.length <= size) {
    return [body];
  }

  const stride = Math.max(1, size - overlap);
  const windows: string[] = [];

  for (let start = 0; start < body.length; start += stride) {
    windows.push(body.slice(start, start + size));

    if (start + size >= body.length) {
      break;
    }
  }

  return windows;
};
