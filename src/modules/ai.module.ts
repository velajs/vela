import { AIService } from '../services/ai.service';
import { AI_BINDING_REF } from '../tokens';
import { createBindingModule } from './create-binding-module';

export const AIModule = createBindingModule({
  name: 'AI',
  serviceClass: AIService,
  bindingRefToken: AI_BINDING_REF,
});
