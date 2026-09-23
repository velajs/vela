import { Injectable } from '../container/decorators';
import { declareRootDefault } from '../container/root-defaults';
import { InjectionToken, defineProvider } from '../container/types';
import type { NonceStore } from './types';

/** Overridable {@link NonceStore} token; defaults to `MemoryNonceStore`. */
export const NONCE_STORE = /* @__PURE__ */ new InjectionToken<NonceStore>('NONCE_STORE');

/**
 * Default in-isolate {@link NonceStore}: a `Map<nonce, exp>` with lazy expiry
 * pruning.
 *
 * LIMITATION (by design, must stay prominent): this enforces single-use ONLY
 * within a single isolate's memory. On a multi-isolate runtime (Cloudflare
 * Workers) a replay landing on a different isolate before `exp` is NOT caught
 * here — cross-isolate single-use requires a shared store (Durable Object / KV)
 * provided for the `NONCE_STORE` token by an adapter. Until then,
 * single-use degrades to "replay-once-per-isolate within the short `exp`
 * window". The workflow layer does not rely on this for correctness: `step.do`
 * memoization is the primary idempotency layer, and this nonce check is
 * defense-in-depth.
 */
@Injectable()
export class MemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();

  async claim(nonce: string, expEpochSeconds: number): Promise<boolean> {
    this.prune();
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, expEpochSeconds);
    return true;
  }

  /** Drop entries whose expiry has passed so the map cannot grow unbounded. */
  private prune(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [nonce, exp] of this.seen) {
      if (exp < now) this.seen.delete(nonce);
    }
  }
}

// Declared with the token, so every application that can inject NONCE_STORE
// has this per-isolate default. A runtime adapter or one @Global() module can
// provide a shared store instead.
declareRootDefault(defineProvider(NONCE_STORE, { useClass: MemoryNonceStore }));
