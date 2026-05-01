import { KVService } from '../services/kv.service';
import { KV_BINDING_REF } from '../tokens';
import { createBindingModule } from './create-binding-module';

export const KVModule = createBindingModule({
  name: 'KV',
  serviceClass: KVService,
  bindingRefToken: KV_BINDING_REF,
});
