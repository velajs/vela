import { Injectable, Logger } from '@velajs/vela';

@Injectable()
export class Notifier {
  readonly #logger = new Logger(Notifier.name);

  notify(message: string): void {
    this.#logger.log(message);
  }
}
