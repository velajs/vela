import { VectorizeService } from '../services/vectorize.service';
import { VECTORIZE_BINDING_REF } from '../tokens';
import { createBindingModule } from './create-binding-module';

export const VectorizeModule = createBindingModule({
  name: 'Vectorize',
  serviceClass: VectorizeService,
  bindingRefToken: VECTORIZE_BINDING_REF,
});
