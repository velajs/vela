import { Controller, Get } from '@velajs/vela';
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
