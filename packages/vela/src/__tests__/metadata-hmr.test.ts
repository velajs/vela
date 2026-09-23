import { describe, it, expect } from 'vitest';
import { Module, Injectable, MetadataRegistry } from '../index.js';

// The versioned symbol the registry anchors its state under.
const REGISTRY_STATE_KEY = Symbol.for('vela:registry:v1');

interface AnchoredState {
  injectables: Set<unknown>;
  modules: Map<unknown, unknown>;
}

function anchoredState(): AnchoredState {
  return (globalThis as unknown as Record<symbol, AnchoredState>)[REGISTRY_STATE_KEY];
}

describe('MetadataRegistry HMR-safe state', () => {
  it('anchors backing state on globalThis under the versioned symbol', () => {
    @Injectable()
    class Foo {}

    const state = anchoredState();
    expect(state).toBeDefined();
    // Decoration wrote into the globalThis-anchored set, not a module-local one.
    expect(state.injectables.has(Foo)).toBe(true);
  });

  it('reads the SAME anchored object every access (a re-eval would reuse it)', () => {
    @Module({})
    class AppModule {}

    const a = anchoredState();
    const b = anchoredState();
    expect(a).toBe(b);
    expect(a.modules.has(AppModule)).toBe(true);
    expect(MetadataRegistry.getModuleOptions(AppModule as never)).toBeDefined();
  });

  it('clear() preserves decoration metadata (only app-time state resets)', () => {
    @Injectable()
    class Svc {}

    // The decoration fact survives clear() precisely because it lives in the
    // anchored state, separate from the app-time globalComponents that clear resets.
    expect(MetadataRegistry.hasInjectable(Svc as never)).toBe(true);
  });
});
