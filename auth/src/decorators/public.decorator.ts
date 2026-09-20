import { Reflector } from '@velajs/vela';

export const Public = Reflector.createDecorator<boolean>({ key: 'vela.auth.public' });
export const PUBLIC_KEY = Public.KEY;
