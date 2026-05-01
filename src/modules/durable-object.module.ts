import { DurableObjectService } from '../services/durable-object.service';
import { DO_BINDING_REF } from '../tokens';
import { createBindingModule } from './create-binding-module';

export const DurableObjectModule = createBindingModule({
  name: 'DurableObject',
  serviceClass: DurableObjectService,
  bindingRefToken: DO_BINDING_REF,
});
