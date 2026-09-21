import { Controller, Get } from '@velajs/vela';
// Keep the runtime import for SWC's constructor metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AppService } from './app.service.js';

@Controller('/')
export class AppController {
  readonly #appService: AppService;

  constructor(appService: AppService) {
    this.#appService = appService;
  }

  @Get()
  getHello() {
    return { message: this.#appService.getHello() };
  }
}
