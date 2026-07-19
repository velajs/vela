/**
 * @velajs/studio-protocol — the frozen wire contract for Vela Studio.
 *
 * Types + string-literal/number constants only; zero runtime dependencies
 * (`sideEffects: false`). This is THE coupling point shared by the server module
 * (M2), the UI transport (M3), and platform adapters (M11). Everything exported
 * here is canonical: later milestones may ADD ops, never rename or remove.
 */
export * from './errors';
export * from './envelope';
export * from './capabilities';
export * from './time-travel';
export * from './data';
export * from './app';
export * from './panels';
export * from './ops';
export * from './http';
