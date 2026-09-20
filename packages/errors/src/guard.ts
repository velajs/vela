/**
 * Structural, realm-safe, BRANDED guard. `instanceof VelaError` is unreliable
 * across DO↔worker RPC and for wire-decoded twins; a bare code+status shape
 * check lets foreign driver errors ride the client-echo path. The brand
 * (`type === 'VelaError'`, an own enumerable prop that survives serialization)
 * closes both failure modes. Nothing load-bearing may use `instanceof`.
 */
export interface VelaErrorLike extends Error {
  type: 'VelaError';
  code: string;
  status: number;
  hint?: string;
  docsUrl?: string;
  data?: unknown;
}

export const isVelaError = (error: unknown): error is VelaErrorLike => {
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<VelaErrorLike>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.status === 'number' &&
    candidate.type === 'VelaError'
  );
};
