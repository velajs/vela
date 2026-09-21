import { Container } from '../container/container';
import { InjectionToken } from '../container/types';
import {
  resolvePipelineComponents,
  resolveScopedComponentsAsync,
} from '../pipeline/scoped-components';
import type { CanActivate, PipeTransform } from '../pipeline/types';

export async function verifyComponents(container: Container): Promise<void> {
  const token = new InjectionToken<CanActivate>('guard');
  const guards: CanActivate[] = await resolvePipelineComponents('guard', [token], container);
  const pipe = new InjectionToken<PipeTransform>('pipe');
  // @ts-expect-error Kind selects component type; entries cannot widen it to permit another kind.
  resolvePipelineComponents('guard', [pipe], container);
  class Handler {}
  const result: CanActivate[] = await resolveScopedComponentsAsync(
    'guard',
    Handler,
    'run',
    container,
    'owner',
  );
  // @ts-expect-error Async resolution of guards does not produce pipes.
  const invalid: PipeTransform[] = result;
  void [guards, invalid];
}
