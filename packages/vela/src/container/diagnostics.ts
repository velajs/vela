import type { Diagnostics } from './types';

/**
 * Apply the container's diagnostics policy to a wiring problem the application
 * can survive: `'log'` warns, `'throw'` fails the caller (bootstrap, when the
 * problem is found while loading modules), `'silent'` ignores it.
 */
export function reportDiagnostic(mode: Diagnostics, message: string): void {
  if (mode === 'silent') return;
  if (mode === 'throw') throw new Error(message);
  console.warn(message);
}
