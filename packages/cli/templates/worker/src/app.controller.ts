import { Controller, Get } from '@velajs/vela';
import { AppService } from './app.service.js';

@Controller('/')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello() {
    return { message: this.appService.getHello() };
  }
}
