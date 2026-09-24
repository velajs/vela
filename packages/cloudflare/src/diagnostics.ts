import type { Container } from '@velajs/vela/module-kit';

const reported = new Set<string>();

/**
 * Report through the application's diagnostics policy: `'throw'` fails the
 * caller, `'log'` warns once per message in this isolate, `'silent'` skips.
 */
export function reportDiagnostic(container: Container, message: string): void {
  const mode = container.getDiagnostics();
  if (mode === 'silent') return;
  if (mode === 'throw') throw new Error(message);
  if (reported.has(message)) return;
  reported.add(message);
  console.warn(message);
}
