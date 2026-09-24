import { Module } from '@velajs/vela';
import { Notifier } from './notifier.service.js';

@Module({
  providers: [Notifier],
  exports: [Notifier],
})
export class NotificationsModule {}
