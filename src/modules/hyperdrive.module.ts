import { HyperdriveService } from '../services/hyperdrive.service';
import { HYPERDRIVE_BINDING_REF } from '../tokens';
import { createBindingModule } from './create-binding-module';

export const HyperdriveModule = createBindingModule({
  name: 'Hyperdrive',
  serviceClass: HyperdriveService,
  bindingRefToken: HYPERDRIVE_BINDING_REF,
});
