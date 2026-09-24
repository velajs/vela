import { Injectable } from '@velajs/vela';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello from Vela!';
  }
}
