/**
 * Feature-detection stub. M2 ships the seam; real detection (probing which
 * `@velajs/*` packages the app actually wired) lands in M4. Until then every
 * feature reports `false` and the derived write gates come straight from the
 * resolved editable config.
 */
import { Inject, Injectable } from '@velajs/vela';
import { STUDIO_FEATURE_KEYS } from '@velajs/studio-protocol';
import type { StudioCapabilities, StudioFeatureKey } from '@velajs/studio-protocol';
import { STUDIO_RESOLVED_CONFIG } from '../tokens';
import { deriveWriteGates } from '../studio.types';
import type { ResolvedStudioConfig } from './../studio.types';

@Injectable()
export class StudioFeaturesService {
  constructor(@Inject(STUDIO_RESOLVED_CONFIG) private readonly config: ResolvedStudioConfig) {}

  /** Which feature namespaces are live. M2 stub: all `false` (detection is M4). */
  features(): Record<StudioFeatureKey, boolean> {
    const out = {} as Record<StudioFeatureKey, boolean>;
    for (const key of STUDIO_FEATURE_KEYS) out[key] = false;
    return out;
  }

  /** The full capability descriptor returned by `studio.capabilities`. */
  capabilities(): StudioCapabilities {
    return {
      features: this.features(),
      writes: deriveWriteGates(this.config.editable),
      timeTravel: null,
    };
  }
}
