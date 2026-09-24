import { Module } from '@velajs/vela';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

@Module({
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
