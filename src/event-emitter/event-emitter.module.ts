import { Module } from '../module/index';
import { EventEmitter } from './event-emitter.service';
import { EventEmitterSubscriber } from './event-emitter.subscriber';

@Module({
  providers: [EventEmitter, EventEmitterSubscriber],
  exports: [EventEmitter],
})
export class EventEmitterModule {}
