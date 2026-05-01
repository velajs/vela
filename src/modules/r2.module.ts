import { R2Service } from '../services/r2.service';
import { R2_BINDING_REF } from '../tokens';
import { createBindingModule } from './create-binding-module';

export const R2Module = createBindingModule({
  name: 'R2',
  serviceClass: R2Service,
  bindingRefToken: R2_BINDING_REF,
});
