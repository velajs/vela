import { Inject, Injectable } from '../../container/decorators';
import { InternalDispatcher } from '../../dispatch/internal-dispatcher';

/** A service whose module, with InternalDispatcher's, loads after bootstrap. */
@Injectable()
export class LateDispatchService {
  constructor(@Inject(InternalDispatcher) readonly dispatcher: InternalDispatcher) {}
}
