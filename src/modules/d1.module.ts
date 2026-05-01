import { D1Service } from '../services/d1.service';
import { D1_BINDING_REF } from '../tokens';
import { createBindingModule } from './create-binding-module';

export const D1Module = createBindingModule({
  name: 'D1',
  serviceClass: D1Service,
  bindingRefToken: D1_BINDING_REF,
});
