/**
 * `studio.capabilities` — the capability-negotiation op. Assembles the wire
 * descriptor from {@link StudioFeaturesService} (real feature detection) plus
 * the config-derived write gates. `timeTravel` stays `null` until a
 * `TimeTravelPort` is bound (M8).
 */
import { Inject, Injectable } from '@velajs/vela';
import type { StudioCapabilities } from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext } from '../studio.types';
import { StudioFeaturesService } from '../features/features.service';

@Injectable()
export class StudioCapabilitiesOps {
  constructor(@Inject(StudioFeaturesService) private readonly features: StudioFeaturesService) {}

  @AdminRpc({ op: 'studio.capabilities' })
  capabilities(_ctx: AdminOpContext): StudioCapabilities {
    return this.features.capabilities();
  }
}
